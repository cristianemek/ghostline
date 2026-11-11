# SPEC — Autocompletado inline en VS Code con Claude Code (suscripción)

Nombre provisional: **ghostline** (cámbialo si quieres).
Uso: **personal**, repo privado. No se distribuye.

## 0. Objetivo y prioridades

Extensión de VS Code que muestra sugerencias inline (texto fantasma, `Tab` para aceptar) generadas por Claude a través de la **CLI oficial de Claude Code** (`claude -p`), autenticada con la suscripción del usuario. **Sin API key.**

Prioridades, en este orden:
1. **Gasto mínimo de tokens** (cada petición con coste constante y pequeño).
2. **Latencia baja.**
3. **Calidad** de las sugerencias.
4. **Seguridad y privacidad.**

Referencia opcional: `github.com/ozgur-d/suggie` (MIT). Puedes mirar cómo parsea `stream-json`, pero **no copies su diseño de "priming" ni su "memory worker"**: manda 10–14k tokens del proyecto al arrancar, a dos procesos, y su conversación crece sin límite. Ese es justo el problema que queremos evitar.

---

## 1. Hechos verificados de la CLI (v2.1.322, 11-nov-2026)

Verificados en otra máquina. **Paso 0 obligatorio: re-verifícalos en esta máquina antes de programar** (ver §12).

- Opciones que usaremos (todas existen y se aceptan juntas):
  `-p`, `--input-format stream-json`, `--output-format stream-json`, `--verbose`, `--include-partial-messages`, `--model`, `--effort`, `--tools ""`, `--safe-mode`, `--strict-mcp-config`, `--disable-slash-commands`, `--no-session-persistence`, `--system-prompt-file <ruta>`.
- `--safe-mode`: desactiva CLAUDE.md, skills, plugins instalados, hooks, servidores MCP, comandos y agentes personalizados, etc. **La autenticación sigue funcionando.**
- `--tools ""`: desactiva todas las herramientas integradas (el modelo no puede leer, editar ni ejecutar nada).
- `--effort` admite: `low`, `medium`, `high`, `xhigh`, `max`. Usaremos `low`.
- `--model haiku` se resuelve a `claude-haiku-5-5` (aparece en el mensaje `system/init`).
- `--system-prompt-file` existe: úsalo en vez de `--system-prompt "<texto>"` para no pasar texto multilínea como argumento (importante en Windows).
- **Entrada** (una línea JSON por mensaje):
  `{"type":"user","message":{"role":"user","content":"..."}}`
- **Salida**: NDJSON con **más tipos de los esperados**. Se han visto: `active_goal`, `autocompact_state`, `system` (subtipos `init` y `status`), `stream_event` (con `--include-partial-messages`), `assistant` y `result`. **Ignora cualquier tipo desconocido.**
- `system/init` incluye `model`, `tools` (debe ser `[]`), `mcp_servers` (debe ser `[]`) y `apiKeySource`.
- `result` incluye: `subtype`, `is_error`, `result` (texto final), `duration_ms`, `duration_api_ms`, `total_cost_usd`, `num_turns` y `usage` con `input_tokens`, `output_tokens`, `output_tokens_details.thinking_tokens`, `cache_read_input_tokens` y `cache_creation_input_tokens`.
  **Ojo:** con un error de autenticación llegó `subtype: "success"` pero `is_error: true` y el error en `result`. Decide por `is_error`, no por `subtype`.

---

## 2. Arquitectura

TypeScript, empaquetado con esbuild, **cero dependencias de runtime** (solo devDependencies). VS Code `^1.98.0`.

```
src/
  extension.ts            activación, comandos, barra de estado
  config.ts               lectura de ajustes
  cli/resolveCli.ts       localizar el ejecutable de claude
  cli/streamParser.ts     parser NDJSON robusto (líneas partidas, tipos desconocidos)
  cli/workerPool.ts       procesos "de un solo uso" precalentados (§3)
  completion/provider.ts  InlineCompletionItemProvider
  completion/promptBuilder.ts
  completion/postprocess.ts
  completion/cache.ts     LRU + typeahead (§6)
  context/exclusions.ts   filtro de archivos sensibles (§10)
  usage/usageTracker.ts   tokens, peticiones, latencias, límite diario (§7)
  learning/               Fase 2 (§8)
test/
  unit/                   tests unitarios
  fixtures/               salidas reales de la CLI (anonimizadas)
  fake-claude.js          CLI simulada para tests de integración
```

### Resolver el ejecutable (`resolveCli.ts`)
- Ajuste `ghostline.cliPath`. Si está vacío, buscar `claude` en `PATH`; en Windows, respetar `PATHEXT`.
- **Lanzar siempre con `shell: false`.**
- En Windows, preferir `claude.exe` (instalador nativo). Si solo se encuentra `claude.cmd` o `claude.bat`, **no intentes lanzarlo con shell**. Muestra un error claro: recomendar el instalador nativo o poner en `ghostline.cliPath` la ruta al `.exe`. Node rechaza `.cmd`/`.bat` sin shell, y con shell el escapado de argumentos es inseguro.

---

## 3. Procesos: "de un solo uso, precalentados"

Objetivo: **cada sugerencia es una conversación nueva, sin historial**, para que el coste sea constante, pero sin pagar el tiempo de arranque en cada petición.

- Mantener **exactamente 1 proceso en espera**, ya lanzado y esperando entrada por stdin.
- Al llegar una petición: tomar ese proceso, escribir **un único** mensaje de usuario, leer hasta `result`, cerrar stdin y terminar el proceso. **Lanzar inmediatamente otro en espera**, en segundo plano.
- Argumentos de lanzamiento:
  ```
  -p --input-format stream-json --output-format stream-json --verbose
  --include-partial-messages
  --model <ghostline.model, por defecto haiku>
  --effort <ghostline.effort, por defecto low>
  --tools "" --safe-mode --strict-mcp-config --disable-slash-commands
  --no-session-persistence
  --system-prompt-file <ruta al system prompt>
  ```
- `cwd`: una carpeta vacía propia dentro de `os.tmpdir()` (por ejemplo `ghostline-cwd`). **Nunca la carpeta del proyecto.**
- `env`: heredar. Al recibir `system/init`, registrar `apiKeySource`. Si indica que se está usando una API key (por ejemplo `ANTHROPIC_API_KEY`), mostrar un **aviso visible**: se estaría facturando la API en vez de la suscripción.
- Comprobar en `system/init` que `tools` y `mcp_servers` son listas vacías; si no, avisar en el log.
- Timeout por petición: `ghostline.requestTimeoutMs` (por defecto 8000). Si se supera, matar el proceso y devolver sin sugerencia.
- **Cancelación** (VS Code cancela porque el usuario siguió escribiendo): matar el proceso en curso para no generar más salida. El de reserva ya está listo.
- Reciclar el proceso en espera si lleva más de 10 minutos sin usarse.
- **Mide en el Paso 0** si la CLI emite algo antes de recibir la primera entrada. Úsalo para definir cuándo un proceso está "listo".
- **Modo alternativo** (`ghostline.workerMode = "persistent"`): un único proceso de larga duración cuya conversación se recicla cada `ghostline.recycleEvery` peticiones (por defecto 8), con otro de reserva. Solo para el caso de que el modo de un solo uso resulte lento en esta máquina.

---

## 4. Prompt

### System prompt (archivo, estable, en inglés, corto)
Reglas:
- Eres un motor de autocompletado.
- Devuelve **solo** el texto a insertar en `<cursor/>`, sin explicaciones, sin markdown y sin bloques de código.
- No repitas código que ya esté antes o después del cursor.
- Respeta la indentación, las comillas, el punto y coma y el estilo de nombres.
- Prefiere la sugerencia útil más corta (expresión, línea o bloque pequeño).
- Si no tienes una sugerencia buena, devuelve una cadena vacía.

### Mensaje de usuario
Orden fijo:
1. **Bloque estable** (Fase 2: perfil de estilo del proyecto). Va primero y es idéntico byte a byte entre peticiones, para que pueda aprovechar la caché de prompts.
2. **Bloque variable**: ejemplos aceptados similares (Fase 2), y después:
   ```
   <file path="src/foo.ts" language="typescript">
   <prefix>…últimas ~60 líneas, máx. 3000 caracteres…</prefix><cursor/><suffix>…siguientes ~20 líneas, máx. 1000 caracteres…</suffix>
   </file>
   ```
- Presupuesto: **objetivo ≤ 1.500 tokens de entrada por petición** (sin contar el system prompt), con un **límite duro de 2.500**. Estima con `caracteres / 3.5` y recorta el prefijo por arriba.
- Caché de prompts: comprueba `cache_read_input_tokens` en `result`. Si siempre es 0, el bloque estable probablemente es más corto que el mínimo que se cachea. **No lo rellenes artificialmente sin medir antes si compensa.**

---

## 5. Postprocesado (`postprocess.ts`)

- Quitar bloques de código, espacios en blanco al principio y al final, y respuestas tipo "OK" o explicaciones evidentes.
- **Eliminar solapes**: si el inicio de la sugerencia repite el final del prefijo (línea actual), recortarlo. Si el final repite el inicio del sufijo, recortarlo.
- Limitar a `ghostline.maxLines` líneas (por defecto 6).
- Ajustar la indentación de las líneas siguientes a la de la línea actual.
- Si queda vacía, no mostrar nada.

---

## 6. Cuándo pedir sugerencias (ahorra tokens)

- **Modo**: `ghostline.triggerMode` = `auto` | `manual`.
  - En `manual`, el proveedor ignora `InlineCompletionTriggerKind.Automatic` y solo responde a `Invoke`. El usuario usa el comando nativo `editor.action.inlineSuggest.trigger`; verifica su atajo por defecto.
- **En `auto`, pedir solo si:**
  - el documento es de esquema `file` o `untitled`, no está excluido (§10) y pesa menos de 1 MB;
  - el lenguaje no está en `ghostline.disabledLanguages`;
  - el cursor está al final de la línea o solo tiene detrás espacios o caracteres de cierre (`)]}"'`;`);
  - el usuario no está tecleando rápido (más de 6 pulsaciones por segundo en los últimos 2 s → esperar).
- Espera tras dejar de teclear: `ghostline.debounceMs`, por defecto 350.
- **Como máximo 1 petición en curso**; una nueva cancela la anterior.
- **Caché LRU** (200 entradas, 5 minutos), con clave = hash(ruta, últimos 500 caracteres del prefijo, primeros 200 del sufijo).
- **Typeahead**: si el usuario escribe exactamente el comienzo de la última sugerencia mostrada, servir el resto localmente (0 tokens).
- **Límite diario**: `ghostline.dailyRequestLimit`, por defecto 1500. Al alcanzarlo se pausa el modo `auto`, lo indica la barra de estado y el modo manual sigue funcionando.

---

## 7. Consumo y barra de estado (`usageTracker.ts`)

- Guardar por día en `globalState` (conservar 30 días): peticiones, tokens de entrada, salida, razonamiento (`thinking_tokens`), lectura y escritura de caché, aceptadas, mostradas y latencias.
- **Barra de estado**: `ghostline 123 · 180k tok · 34% ✓`. El tooltip muestra el desglose, la latencia p50/p95, el modelo y `apiKeySource`.
- Al hacer clic, un menú rápido con: pausar o reanudar, cambiar entre auto y manual, abrir el log, ver el consumo de los últimos 7 días y reiniciar contadores.
- **Canal de salida "ghostline"**, una línea por petición: espera hasta tener proceso, tiempo hasta el primer token, tiempo total, tokens (entrada, salida, razonamiento, caché) y si se aceptó.
  **No registrar prompts completos** salvo que `ghostline.debug.logPrompts = true`.

---

## 8. Fase 2 — "Aprender" sin entrenar el modelo

No se puede reentrenar Claude, pero el sistema se adapta a ti con datos **guardados solo en local**.

**a) Feedback**
- Aceptada: mediante el `command` del `InlineCompletionItem`.
- Ignorada: se mostró y no se aceptó antes de la siguiente petición o de mover el cursor.
- Usa solo API estable de VS Code.

**b) Ejemplos de lo que aceptas (few-shot)**
- Guardar las últimas 200 sugerencias aceptadas por lenguaje: las 5 líneas previas más el texto aceptado. Se guardan en `workspaceState` y **nunca de archivos excluidos**.
- En cada petición, incluir hasta 2 ejemplos parecidos (similitud de Jaccard sobre identificadores), con un máximo de unos 300 tokens.
- Ajuste: `ghostline.learning.examples` (por defecto `true`).

**c) Perfil de estilo del proyecto**
- Comando **"ghostline: Aprender estilo del proyecto"**:
  - toma hasta 5 archivos fuente no excluidos (máximo unos 6k tokens en total);
  - pide a Claude, con la misma CLI y `effort low`, una guía de estilo de **200 tokens como máximo** (nombres, comillas, punto y coma, indentación y librerías habituales);
  - la guarda y la abre en un editor para que puedas revisarla o editarla.
- Se usa como **bloque estable** del prompt (§4). Solo se regenera bajo demanda.

**d) Disparo adaptativo** (menos ruido y menos tokens)
- Medir la tasa de aceptación por lenguaje y tipo de contexto: tras `.`, tras `(`, línea nueva, final de línea.
- Si en las últimas 40 mostradas de un contexto la aceptación baja del 10 %, dejar de disparar automáticamente en ese contexto durante 24 h. El modo manual sigue funcionando.

**e) Aviso de velocidad**
- Si la latencia p50 supera 1.500 ms, sugerir el modo manual o reducir el contexto.

## 9. Fase 3 (opcional) — Contexto de símbolos vía LSP
- Para hasta 3 identificadores de la línea actual: `vscode.executeDefinitionProvider` → incluir la línea de firma de cada definición. Máximo unos 400 tokens, y nunca de archivos excluidos.

---

## 10. Seguridad y privacidad

- **Exclusiones** con patrones glob comprobados mediante `vscode.languages.match({ pattern }, document)`, sin dependencias. Por defecto:
  ```
  **/.env, **/.env.*, **/*.pem, **/*.key, **/*.p12, **/*.pfx,
  **/id_rsa*, **/id_ed25519*, **/*secret*, **/*credential*,
  **/.npmrc, **/.pypirc, **/.netrc, **/.aws/**, **/.ssh/**, **/*.kdbx
  ```
  En archivos excluidos: no disparar nunca, no incluirlos en ningún contexto y no guardar feedback.
- Fase 1: **solo se envía contexto del documento actual**.
- `package.json` → `capabilities.untrustedWorkspaces.supported: false`.
- Ninguna conexión de red propia. Sin telemetría. El único proceso externo es la CLI.

## 11. Ajustes (`package.json` → `contributes.configuration`)

| Ajuste | Por defecto |
|---|---|
| `ghostline.enabled` | `true` |
| `ghostline.cliPath` | `""` |
| `ghostline.model` | `"haiku"` |
| `ghostline.effort` | `"low"` |
| `ghostline.triggerMode` | `"auto"` |
| `ghostline.debounceMs` | `350` |
| `ghostline.maxLines` | `6` |
| `ghostline.requestTimeoutMs` | `8000` |
| `ghostline.dailyRequestLimit` | `1500` |
| `ghostline.disabledLanguages` | `["markdown", "plaintext"]` |
| `ghostline.excludePatterns` | lista de §10 |
| `ghostline.workerMode` | `"single-use"` |
| `ghostline.recycleEvery` | `8` |
| `ghostline.learning.examples` | `true` |
| `ghostline.debug.logPrompts` | `false` |

---

## 12. Plan de trabajo y pruebas

**Paso 0 — Verificar la CLI en esta máquina** (antes de escribir código):
1. `claude --version` y `claude --help`. Confirmar las opciones de §1.
2. Una llamada real con los argumentos de §3 y un mensaje corto. Guardar la salida, anonimizada, en `test/fixtures/`.
3. Medir: tiempo de arranque hasta estar listo, tiempo hasta el primer token y tokens reales de una sugerencia típica.
4. Informarme de cualquier diferencia con esta spec **antes** de seguir.

**Fase 1 — MVP**: §2–§7 y §10.
- Tests unitarios: `postprocess`, `promptBuilder` (presupuesto de tokens), `exclusions`, `streamParser` (fixtures con tipos desconocidos, líneas partidas y `is_error`), caché y typeahead.
- `fake-claude.js`: lee una línea de stdin y emite `init`, `assistant` y `result` con retardo y texto configurables. Tests de integración del `workerPool` contra ella, **sin gastar tokens**.
- Empaquetar: `npx @vscode/vsce package --no-dependencies`. Instalar con `code --install-extension <archivo>.vsix`.

**Criterios de aceptación de la Fase 1:**
- Mediana de tokens de entrada por petición **≤ 2.000** (medido en `usage`).
- Ninguna petición en archivos excluidos (probar con `.env.local`).
- `apiKeySource` registrado y aviso si no se usa la suscripción.
- El log muestra latencia p50/p95; si la p50 supera 1,5 s, informar y proponer ajustes.
- Lint y tests en verde; cero dependencias de runtime.

**Fase 2**: §8. **Fase 3**: §9, solo si la Fase 2 va bien.

**Reglas de trabajo:**
- Trabajar fase por fase.
- Al terminar cada fase: commit, `.vsix` generado y un resumen con las cifras medidas.
- No añadir dependencias de runtime sin preguntar.
