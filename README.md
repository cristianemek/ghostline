# ghostline

Autocompletado inline para VS Code (texto fantasma, `Tab` para aceptar) generado por Claude a través de la
**CLI oficial de Claude Code** (`claude -p`), con tu suscripción y **sin API key**.

Uso personal. Prioridades, por este orden: gasto mínimo de tokens, latencia baja, calidad, seguridad.

- Especificación: [`docs/SPEC.md`](docs/SPEC.md)
- Verificación de la CLI y medidas iniciales: [`docs/paso-0.md`](docs/paso-0.md)
- Cifras y decisiones de cada fase: [`docs/fase-1.md`](docs/fase-1.md), [`docs/fase-2.md`](docs/fase-2.md)

## Requisitos

- VS Code 1.98 o posterior.
- Claude Code instalado e iniciado con tu suscripción (`claude` → `/login`).
- En Windows hace falta un `claude.exe`: el del instalador nativo o el que trae el paquete de npm
  (ghostline resuelve solo el `claude.cmd` de npm a su `.exe`). Nunca se lanza nada a través de un shell.

## Instalación

```
npm install
npm run package
code --install-extension ghostline-0.2.0.vsix
```

## Uso

- **Modo auto** (por defecto): al dejar de teclear aparece la sugerencia en gris. `Tab` la acepta, `Esc` la descarta.
- **Modo manual** (`ghostline.triggerMode: "manual"`): solo sugiere al invocar *Desencadenar sugerencia insertada*
  (`editor.action.inlineSuggest.trigger`). VS Code 1.144 ya no trae atajo por defecto para ese comando, así que
  ghostline le asigna `Alt+\` (la tecla física `\` del teclado US; en teclado español es `Alt+ç`). Se cambia en
  *Métodos abreviados de teclado*.
- **Barra de estado**: `ghostline 123 · 180k tok · 34% ✓` = peticiones de hoy · tokens de hoy · sugerencias aceptadas.
  El tooltip desglosa tokens, latencia p50/p95, modelo, `apiKeySource` y el uso de los límites de la suscripción.
  Al hacer clic: pausar, cambiar de modo, abrir el log, ver los últimos 7 días, reiniciar contadores.
- **Log**: canal de salida *ghostline*, una línea por petición (espera, primer token, total, tokens, resultado).
  Los prompts no se registran salvo con `ghostline.debug.logPrompts`.

## Cómo gasta tan poco

| Mecanismo | Efecto |
|---|---|
| Cada sugerencia es una conversación nueva en un proceso precalentado | Coste constante por petición; sin historial que crezca. Ahorra ~0,7 s de arranque. |
| `--tools "" --safe-mode --strict-mcp-config --setting-sources project`, `cwd` vacío | Nada de herramientas, MCP, CLAUDE.md ni ajustes de usuario en el prompt. |
| Caché de prompts desactivada en modo de un solo uso | Cada prompt es único: escribir en caché costaba el doble y nunca se leía. |
| Presupuesto calibrado con el consumo real | El contexto se recorta para que la petición entera ronde los 1.900 tokens de entrada. |
| Debounce, caché LRU (200 entradas, 5 min) y typeahead | Si sigues tecleando lo sugerido o vuelves al mismo sitio, 0 tokens. |
| Corte anticipado de la respuesta | Si el modelo se alarga o empieza a explicar, se mata el proceso. |
| Límite diario (`ghostline.dailyRequestLimit`) | Al alcanzarlo se pausa el modo auto; el manual sigue. |

## Lo que aprende de ti

No se entrena ningún modelo: ghostline se adapta con datos guardados solo en este equipo.

- **Ejemplos**: recuerda las últimas 200 sugerencias que aceptas por lenguaje y envía hasta 2 parecidas a lo
  que estás escribiendo.
- **Perfil de estilo**: *ghostline: Aprender estilo del proyecto* envía el principio de hasta 5 archivos que tú
  confirmas y guarda una guía de ~200 tokens que puedes editar. Se añade a las peticiones en archivos nuevos o
  cortos, donde no hay código del que deducir el estilo.
- **Disparo adaptativo**: si en un contexto (por ejemplo, TypeScript tras un punto) aceptas menos del 10 % de
  las últimas 40 sugerencias, deja de sugerir ahí 24 h y te avisa. El modo manual sigue.
- **Aviso de velocidad**: si la latencia mediana del día supera 1,5 s, propone el modo manual o reducir el contexto.

*ghostline: Borrar lo aprendido en este proyecto* lo elimina todo.

## Ajustes

| Ajuste | Por defecto | |
|---|---|---|
| `ghostline.enabled` | `true` | |
| `ghostline.cliPath` | `""` | Vacío: busca `claude` en `PATH`. |
| `ghostline.model` | `"haiku"` | |
| `ghostline.effort` | `"low"` | |
| `ghostline.reasoning` | `"minimal"` | `adaptive` deja razonar al modelo: p50 ~1,6 s y +13 % de coste, sin mejora medible. |
| `ghostline.triggerMode` | `"auto"` | `auto` \| `manual` |
| `ghostline.debounceMs` | `350` | |
| `ghostline.maxLines` | `6` | |
| `ghostline.requestTimeoutMs` | `8000` | |
| `ghostline.dailyRequestLimit` | `1500` | 0 = sin límite. |
| `ghostline.disabledLanguages` | `["markdown", "plaintext"]` | Solo afecta al modo auto. |
| `ghostline.excludePatterns` | ver abajo | Archivos sensibles. |
| `ghostline.workerMode` | `"single-use"` | `persistent`: un proceso que se recicla cada N peticiones. |
| `ghostline.recycleEvery` | `8` | |
| `ghostline.promptCache` | `"auto"` | `auto`: off en `single-use`, on en `persistent`. |
| `ghostline.context.prefixLines` | `60` | |
| `ghostline.context.suffixLines` | `20` | |
| `ghostline.learning.examples` | `true` | Guardar y enviar ejemplos de lo aceptado. |
| `ghostline.learning.adaptiveTrigger` | `true` | Silenciar 24 h los contextos donde casi nunca aceptas. |
| `ghostline.debug.logPrompts` | `false` | |

## Privacidad y seguridad

- Solo se envía contexto del **documento actual**: hasta 60 líneas antes y 20 después del cursor.
- **Archivos excluidos**: nunca se sugiere en ellos (tampoco en manual), nunca se envían y nunca se guarda nada de ellos.
  Por defecto: `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `*secret*`,
  `*credential*`, `.npmrc`, `.pypirc`, `.netrc`, `.aws/**`, `.ssh/**`, `*.kdbx`.
- Solo en áreas de trabajo de confianza. Sin conexiones de red propias y sin telemetría: el único proceso externo es la CLI.
- Si la CLI se autentica con una API key (`apiKeySource` distinto de `none`), ghostline avisa: se estaría
  facturando la API en vez de la suscripción.
- El modelo no tiene herramientas: no puede leer, editar ni ejecutar nada.

## Desarrollo

| Comando | |
|---|---|
| `npm run check` | Tipos, lint y tests unitarios/integración (CLI simulada, no gasta tokens). |
| `npm run test:e2e` | Arranca VS Code en un perfil aislado con la CLI simulada y prueba el proveedor real. |
| `npm run bench -- --n 20` | Mide contra la CLI real (gasta unos miles de tokens de Haiku). `--verbose` muestra las respuestas. |
| `npm run package` | Genera el `.vsix`. |

Cero dependencias de runtime.
