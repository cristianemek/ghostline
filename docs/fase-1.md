# Fase 1 — MVP: cifras y decisiones

Medido el 11-nov-2026 con `npm run bench` contra la CLI real (Claude Code 2.1.322, `claude-haiku-5-5`,
`effort low`, modo `single-use`), reproduciendo "el usuario va a escribir esta línea" sobre el código de este
repositorio, con el mismo pool, constructor de prompts y postprocesado que usa la extensión.

## Criterios de aceptación

| Criterio | Resultado |
|---|---|
| Mediana de tokens de entrada ≤ 2.000 (medido en `usage`) | **1.933** (máx. 2.158) |
| Ninguna petición en archivos excluidos | Comprobado con `.env.local` en un VS Code real (prueba e2e), en auto y en manual, además de los tests del filtro. |
| `apiKeySource` registrado y aviso si no es la suscripción | `none` en esta máquina; aviso visible y fondo de advertencia en la barra si es otro valor. |
| Latencia p50/p95 en el log | Línea por petición + resumen cada 20 peticiones. **p50 868 ms · p95 1.713 ms** |
| Lint y tests en verde; cero dependencias de runtime | 130 tests, `tsc` y ESLint limpios; `dependencies` vacío. |

## Medidas (20 peticiones por variante, mismas muestras)

| | `reasoning: minimal` (por defecto) | `reasoning: adaptive` |
|---|---|---|
| Latencia total p50 / p95 | **868 ms / 1.713 ms** | 1.574 ms / 3.379 ms |
| Primer token p50 | 643 ms | 1.513 ms |
| Tokens de entrada, mediana | 1.933 | 1.911 |
| Tokens de salida, mediana | 30 | 68 |
| Tokens de razonamiento por petición | 78 | 175 |
| Coste equivalente por petición | **0,000240 $** | 0,000276 $ |
| Primera línea idéntica al original | 8 / 20 | 7 / 20 |

A 1.500 peticiones diarias (el límite por defecto) son ~0,36 $ equivalentes al día.

## Hallazgos posteriores al Paso 0

1. **Haiku 5.5 razona aunque `effort` sea `low`.** En ~40 % de las peticiones dedica 200–500 tokens de salida a
   razonar, lo que lleva la respuesta a 2–3 s. No se puede desactivar: se probaron `CLAUDE_CODE_DISABLE_THINKING`,
   `MAX_THINKING_TOKENS=0`, `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` y `alwaysThinkingEnabled: false`, sin efecto.
   Lo único que funciona es pedírselo en el system prompt, que lo reduce a la mitad. De ahí el ajuste
   `ghostline.reasoning` (dos system prompts que se diferencian en una línea).
2. **Una respuesta vacía le cuesta el doble.** Con la instrucción "si no hay sugerencia, no devuelvas nada", cuando
   el modelo obedecía la CLI repetía la petición por su cuenta (`num_turns: 2`, el doble de tokens, 3,4 s). Ahora
   se le pide el marcador `<none/>`, que el postprocesado trata como "sin sugerencia".
3. **El tokenizador depende mucho del contenido**: entre 2,4 y 2,9 caracteres por token en TypeScript. La sobrecarga
   fija es de ~1.000 tokens (600 de la CLI + system prompt + envoltorio del prompt). El estimador arranca en
   2,7 / 1.000 y se recalibra con el consumo real, descartando peticiones atípicas.
4. **`editor.action.inlineSuggest.trigger` no tiene atajo por defecto en VS Code 1.144.** ghostline le asigna
   `Alt+\` para que el modo manual sea usable.
5. **El modelo a veces explica en vez de completar.** El postprocesado corta desde la primera línea de prosa
   (salvo en comentarios, cadenas y documentos de texto) y la lectura de la respuesta se interrumpe en ese momento.

## Diferencias con la spec

| Spec | Implementado | Motivo |
|---|---|---|
| Argumentos de §3 | + `--setting-sources project` | Los ajustes de usuario añadían ~1.750 tokens por petición. |
| "Aprovechar la caché de prompts" | `DISABLE_PROMPT_CACHING=1` en `single-use` | Nunca se leía y escribirla cuesta 2x (−47 % de coste). |
| Estimar con `caracteres / 3,5` | Estimador autocalibrado | El ratio real es 2,4–2,9. |
| Objetivo ≤ 1.500 tokens sin contar el system prompt | Objetivo de 1.900 tokens **totales medidos** | Es lo que hace cumplir la mediana ≤ 2.000 con ~1.000 tokens fijos. |
| "Devuelve una cadena vacía" | Devuelve `<none/>` | Hallazgo 2. |
| `.cmd`/`.bat` → error | El shim de npm se resuelve a su `claude.exe`; cualquier otro `.cmd` → error | En esta máquina solo existe el shim. Sigue sin usarse shell. |
| Reciclar el proceso en espera a los 10 min | Se retira a los 10 min y se relanza al volver a teclear | Mismo efecto sin un proceso parado indefinidamente (medido: ~200 MB de memoria en uso cada uno). |
| Quitar espacios al principio de la sugerencia | Se conservan el espacio o el salto de línea que hacen falta | `const x =` + ` 5;` no puede quedar en `const x =5;`. |
| Sugerencia tecleada entera a mano | Cuenta como aceptada | Evita una carrera con el comando de aceptar y es la señal correcta. |

## Prueba e2e

`npm run test:e2e` descarga una copia privada de VS Code en `.vscode-test/` (solo la primera vez), la arranca con
un perfil temporal y la CLI simulada, y ejecuta 12 comprobaciones dentro del host de extensiones real: sugerencia
en auto, typeahead, aceptación, caché, cursor en mitad de línea, **`.env.local` sin peticiones ni en auto ni en
manual**, lenguajes desactivados, modo manual, barra de estado, límite diario, pausa y formato del log.
Resultado: 12 de 12.

No usa el VS Code instalado: comparte estado con el editor del día a día y además rechaza nuevas instancias
mientras se aplica una actualización, que es lo que ocurría en esta máquina durante el desarrollo.
