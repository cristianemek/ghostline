<p align="center"><img src="resources/icon.svg" width="112" alt="Icono de ghostline: un fantasma sobre una línea de código"></p>

# ghostline

Autocompletado inline para VS Code (texto fantasma, `Tab` para aceptar) generado por Claude a través de la
**CLI oficial de Claude Code** (`claude -p`), con tu suscripción y **sin API key**.

Uso personal. Prioridades desde la v0.6: gasto mínimo de tokens, calidad de las sugerencias, seguridad, y la
latencia después (la spec original ponía la latencia por delante de la calidad).

- Especificación: [`docs/SPEC.md`](docs/SPEC.md)
- Verificación de la CLI y medidas iniciales: [`docs/paso-0.md`](docs/paso-0.md)
- Cifras y decisiones de cada fase: [`docs/fase-1.md`](docs/fase-1.md), [`docs/fase-2.md`](docs/fase-2.md),
  [`docs/fase-3.md`](docs/fase-3.md)
- Auditoría de seguridad y robustez: [`docs/auditoria.md`](docs/auditoria.md)
- Cuánto acierta y cómo se mide: [`docs/acierto.md`](docs/acierto.md)
- Latencia, qué la limita y qué se hizo: [`docs/latencia.md`](docs/latencia.md)
- Consumo en uso real y cómo gastar menos: [`docs/consumo.md`](docs/consumo.md)

## Requisitos

- VS Code 1.144 o posterior.
- Claude Code instalado e iniciado con tu suscripción (`claude` → `/login`).
- En Windows hace falta un `claude.exe`: el del instalador nativo o el que trae el paquete de npm
  (ghostline resuelve solo el `claude.cmd` de npm a su `.exe`). Nunca se lanza nada a través de un shell.

## Instalación

Con Node 20 o posterior:

```
npm install
npm run package
code --install-extension ghostline-0.10.0.vsix
```

### En otro equipo (Ubuntu u otro Linux)

El repositorio es privado y no hay nada publicado, así que el `.vsix` se copia o se genera allí.

1. Claude Code con tu suscripción: `npm install -g @anthropic-ai/claude-code`, luego `claude` y `/login`.
2. La extensión, de una de estas dos formas:
   - copia `ghostline-0.10.0.vsix` (unos 55 KB) al otro equipo; o
   - genérala allí: `git clone https://github.com/cristianemek/ghostline.git`, y dentro `npm install` y
     `npm run package`.
3. `code --install-extension ghostline-0.10.0.vsix` y recarga la ventana.

Si la barra de estado dice «sin CLI», VS Code no ha heredado el `PATH` de tu terminal: pon en
`ghostline.cliPath` lo que devuelva `which claude`. Ese ajuste es por equipo y no se sincroniza. Lo aprendido
(ejemplos, perfil de estilo) y los contadores también son de cada equipo.

El código que busca y lanza la CLI en Linux tiene tests, pero hasta ahora ghostline solo se ha ejecutado en
Windows.

## Uso

- **Modo auto** (por defecto): al dejar de teclear aparece la sugerencia en gris. `Tab` la acepta, `Esc` la descarta.
  Se pide al final de la línea o ante caracteres de cierre y, desde la v0.6.1, también en mitad de una línea
  justo donde acabas de teclear (`conversation, |c.queries.Create(…)` → `err := `); la spec original no lo
  contemplaba. Ahí la sugerencia es de una sola línea, y no se pide dentro de una palabra, una cadena o un
  comentario, ni al pegar, borrar o mover el cursor. Se apaga con `ghostline.midLine: false`.
- **Modo manual** (`ghostline.triggerMode: "manual"`): solo sugiere al invocar *Desencadenar sugerencia insertada*
  (`editor.action.inlineSuggest.trigger`). VS Code 1.144 ya no trae atajo por defecto para ese comando, así que
  ghostline le asigna `Alt+\` (la tecla física `\` del teclado US; en teclado español es `Alt+ç`). Se cambia en
  *Métodos abreviados de teclado*.
- **Barra de estado**: `ghostline 8% · Claude 0,04%`. El primero es cuánto llevas hoy de tu propio tope diario
  (`ghostline.dailyRequestLimit`). El segundo, qué parte de una sesión entera de Claude (la ventana de 5 horas
  de la suscripción) se ha llevado ghostline en la sesión en curso; no lo llena que está la sesión, que es
  cosa de todo lo que uses Claude. Es una estimación tirando a alta: lo gastado por ghostline a precio de API
  sobre lo que se midió que vale una sesión (`ghostline.claudeSessionUsd`; el cálculo está en
  [`docs/consumo.md`](docs/consumo.md)). El tooltip añade las cifras detrás de esos dos porcentajes, por dónde
  va la sesión entera y las sugerencias aceptadas. Tokens, latencia y coste están a un clic, en *Consumo de los
  últimos 7 días* y en el log. (La spec pedía `peticiones · tokens · % aceptadas`; se cambió en la v0.8.)
  Al hacer clic: pausar, cambiar de modo, abrir el log, ver los últimos 7 días, reiniciar contadores.
- **Log**: canal de salida *ghostline*, una línea por petición (espera, primer token, total, tokens, resultado).
  Los prompts no se registran salvo con `ghostline.debug.logPrompts`.
- **Últimas sugerencias** (*ghostline: Ver las últimas sugerencias*, o desde el menú): las últimas 40
  respuestas de este proyecto, con la línea donde estaba el cursor, lo que se ofreció, lo que respondió el
  modelo cuando no coincide, y si la aceptaste. Para ver por qué una sugerencia salió mal.

## Cómo gasta tan poco

| Mecanismo | Efecto |
|---|---|
| Cada sugerencia es una conversación nueva en un proceso precalentado | Coste constante por petición; sin historial que crezca. Ahorra ~0,7 s de arranque. |
| `--tools "" --safe-mode --strict-mcp-config --setting-sources project`, `cwd` vacío | Nada de herramientas, MCP, CLAUDE.md ni ajustes de usuario en el prompt. |
| Caché de prompts con escritura corta | El prompt de sistema, con el índice del proyecto dentro, se lee de la caché a un décimo del precio en cada petición. Lo que es propio de cada petición la CLI lo escribe en caché igualmente; se le pide la duración de 5 minutos (1,25x) en vez de la de una hora (2x). |
| Presupuesto calibrado con el consumo real | El archivo se recorta para que la petición ronde los 1.900 tokens de entrada, sin contar el índice del proyecto (que va por caché). |
| Debounce, caché LRU (200 entradas, 5 min) y typeahead | Si sigues tecleando lo sugerido o vuelves al mismo sitio, 0 tokens. |
| Corte anticipado de la respuesta | Si el modelo se alarga o empieza a explicar, se mata el proceso. |
| Sin petición justo tras aceptar | El modelo acaba de decir lo que tenía para ese punto; en uso real, volver a preguntar ahí devolvía vacío (3 de 11 peticiones). La siguiente tecla lo reactiva. |
| Límite diario (`ghostline.dailyRequestLimit`) | Al alcanzarlo se pausa el modo auto; el manual sigue. |

## Lo que sabe de tu proyecto

Con `ghostline.context.symbols` activado (por defecto), además del archivo que editas el modelo recibe:

- **El índice del proyecto** (desde la v0.10): qué funciones y tipos declara tu proyecto, una línea por
  declaración, con los campos de structs e interfaces. ghostline lo construye al abrir el proyecto leyendo los
  archivos de código (Go, TypeScript/JavaScript, Python y Rust; sin dependencias, salida de compilación ni
  tests), lo actualiza al guardar y lo pone en el prompt de sistema. No interviene ningún modelo y no lleva
  valores, solo nombres y tipos. Hasta unos 5.000 tokens: un proyecto que cabe va entero; si no, primero la
  carpeta del archivo que editas y después las más cercanas. Sirve para que una sugerencia use la función que
  ya existe tres archivos más allá en vez de inventarse otra ([`docs/fase-3.md`](docs/fase-3.md)).
- **La declaración de lo que estás usando**: la firma, o los campos, de hasta 3 símbolos de la línea (también
  de después del cursor y de la línea que abrió la llamada), localizada con el servidor de lenguaje.

## Lo que aprende de ti

No se entrena ningún modelo: ghostline se adapta con datos guardados solo en este equipo.

- **Ejemplos** (desactivado por defecto desde la v0.9, `ghostline.learning.examples`): recuerda las últimas
  200 sugerencias por lenguaje que aceptas y que siguen en el archivo 10 minutos después, y envía hasta 2
  parecidas a lo que estás escribiendo. Medido en uso real, hacía que el modelo copiara la forma del ejemplo
  en vez de la declaración que tenía delante ([`docs/acierto.md`](docs/acierto.md)).
- **Perfil de estilo**: *ghostline: Aprender estilo del proyecto* envía el principio de hasta 5 archivos que tú
  confirmas y guarda una guía de ~200 tokens que puedes editar. Se añade a las peticiones en archivos nuevos o
  cortos, donde no hay código del que deducir el estilo.
- **Disparo adaptativo**: si en un contexto (por ejemplo, TypeScript tras un punto) aceptas menos del 10 % de
  las últimas 40 sugerencias, deja de sugerir ahí 24 h y te avisa. El modo manual sigue. «En mitad de línea»
  es un contexto propio: si ahí no te sirve, se silencia solo.
- **Aviso de velocidad**: solo con `reasoning: minimal`, que es el modo en el que se pide rapidez. Si la
  latencia mediana del día supera 1,5 s, propone el modo manual o reducir el contexto. Con `adaptive` el
  modelo se para a razonar a propósito y no se avisa.

*ghostline: Borrar lo aprendido en este proyecto* lo elimina todo, también las últimas sugerencias guardadas.

## Ajustes

Los de siempre, en *Ajustes → Extensiones → ghostline*:

| Ajuste | Por defecto | |
|---|---|---|
| `ghostline.enabled` | `true` | |
| `ghostline.model` | `haiku` | Desplegable: `haiku`, `sonnet` (más regular y rápido, unas 12 veces más caro) u `opus`. |
| `ghostline.triggerMode` | `auto` | `manual`: solo con el atajo. |
| `ghostline.debounceMs` | `600` | Pausa al teclear antes de pedir una sugerencia. |
| `ghostline.dailyRequestLimit` | `1500` | 0 = sin tope. |
| `ghostline.context.symbols` | `true` | Enviar declaraciones de otros archivos del proyecto (índice y símbolos). `false`: solo el archivo actual. |
| `ghostline.disabledLanguages` | `["markdown", "plaintext"]` | Solo afecta al modo auto. |
| `ghostline.excludePatterns` | ver abajo | Archivos sensibles. |

En la sección **Avanzado**, para cuando haga falta:

| Ajuste | Por defecto | |
|---|---|---|
| `ghostline.cliPath` | `""` | Vacío: busca `claude` en el `PATH`. |
| `ghostline.effort` | `medium` | Con `low` Haiku respeta peor las declaraciones (7 frente a 14 aciertos de 16); `high` no mejora. |
| `ghostline.reasoning` | `adaptive` | `minimal`: sin razonar, más rápido y acierta bastante menos. |
| `ghostline.midLine` | `true` | Sugerir también en mitad de una línea, justo donde acabas de teclear. |
| `ghostline.maxLines` | `6` | |
| `ghostline.speculation` | `off` | `line`: se adelanta en cada línea nueva (menos espera, casi el doble de tokens). |
| `ghostline.requestTimeoutMs` | `8000` | |
| `ghostline.claudeSessionUsd` | `80` | Lo que vale una sesión de Claude (5 h) en dólares de API; solo para el segundo porcentaje de la barra de estado. |
| `ghostline.context.prefixLines` / `suffixLines` | `60` / `20` | Líneas del archivo que se envían antes y después del cursor. |
| `ghostline.learning.adaptiveTrigger` | `true` | Silenciar 24 h los sitios donde casi nunca aceptas. |
| `ghostline.learning.examples` | `false` | Enviar como ejemplo sugerencias aceptadas (empeoró el resultado en las pruebas). |
| `ghostline.debug.logPrompts` | `false` | |

Cuatro ajustes internos ya no aparecen en la pantalla de Ajustes, porque en las pruebas tenían un único valor
bueno; se siguen leyendo si los escribes en `settings.json`: `ghostline.workerMode` (`single-use`),
`ghostline.recycleEvery` (`8`), `ghostline.promptCache` (`auto`; `off` la desactiva) y
`ghostline.eagerDebounceMs` (`120`).

## Privacidad y seguridad

- Se envía contexto del **documento actual**: hasta 60 líneas antes y 20 después del cursor. Dos excepciones,
  ambas bajo tu control: el comando de aprender el estilo (envía el principio de los archivos que confirmas) y
  `ghostline.context.symbols`, activado por defecto. Con él viajan **declaraciones de otros archivos del
  proyecto**: en cada petición, el índice del proyecto (firmas de funciones y campos de tipos de sus archivos
  de código, hasta unos 5.000 tokens) y la declaración de hasta 3 símbolos que estés usando. Son nombres y
  tipos, nunca valores ni cuerpos de función, y nunca de un archivo excluido
  ([`docs/fase-3.md`](docs/fase-3.md)). Lo lee ghostline, no el modelo. Con `false` solo se envía el archivo
  actual.
- **Lo que queda en este equipo** (en el almacenamiento del área de trabajo de VS Code, nunca fuera): las
  últimas 40 respuestas con la línea del cursor, para poder revisarlas, y, si los activas, los ejemplos
  aceptados.
- **Archivos excluidos**: nunca se sugiere en ellos (tampoco en manual), nunca se envían y nunca se guarda nada de ellos.
  Por defecto: `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `*secret*`,
  `*credential*` (archivos y carpetas), `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, `.aws/**`, `.ssh/**`,
  `.gnupg/**`, `.kube/**`, `.docker/config.json`, `*.tfvars`, `*.tfstate*`, `*.jks`, `*.keystore`, `.htpasswd`, `*.kdbx`.
- **Un repositorio no puede aflojar tu configuración.** Los ajustes que deciden qué se ejecuta, se envía o se
  gasta (modelo, límite diario, símbolos, log de prompts…) solo se leen de tus ajustes de usuario. Lo que sí
  admite valor por área de trabajo se combina quedándose con lo más restrictivo: las exclusiones y los
  lenguajes desactivados se suman, puede desactivar ghostline o pedir el modo manual, pero no al revés.
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
| `npm run bench:typing` | Simula tecleo real en VS Code contra la CLI real y compara la espera con y sin especulación. |
| `npm run package` | Genera el `.vsix`. |

Cero dependencias de runtime.
