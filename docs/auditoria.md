# Auditoría de seguridad y robustez (v0.4.0)

Revisión completa del código tras la Fase 3, con cada sospecha confirmada antes de corregirla (reproducción,
test o medición con el modelo real). Todo lo de esta página está corregido salvo lo que figura en
«Riesgos que se aceptan».

## Dependencias

| Antes | Ahora |
|---|---|
| `npm audit`: 10 avisos moderados (todos por `minimatch` < 11.0.1, GHSA-g3hv-75wg-m249, vía ESLint) | 0 vulnerabilidades (`overrides` a `minimatch` 11) |
| TypeScript 5.9, `@types/node` 20, `@types/vscode` 1.98, objetivo Node 20 | TypeScript 6.0.3 (lo último que admite typescript-eslint), tipos de Node 24 y VS Code 1.144, objetivo Node 24 |
| `npx --yes @vscode/vsce` (ejecuta la última versión publicada, sin fijar) | `@vscode/vsce` 4.1.0 fijado en `package-lock.json` |

VS Code mínimo: **1.144** (el instalado; su runtime es Node 24.22). Node 20, el de VS Code 1.98, ya no recibe
parches. La CLI de Claude Code instalada (2.1.322) es la última publicada.

## Seguridad

| # | Gravedad | Hallazgo | Corrección |
|---|---|---|---|
| S1 | Alta | **ReDoS en los patrones de exclusión.** Se convertían a expresión regular; un patrón con seis `**/` tardaba 1,1 s por archivo y con diez no terminaba. Un `.vscode/settings.json` de un repositorio bastaba para congelar el editor. | Comparador propio sin expresiones regulares, lineal. Los patrones de más de 200 caracteres o 64 alternativas se rechazan con aviso. |
| S2 | Alta | **Un repositorio podía aflojar la configuración**: vaciar las exclusiones, quitar el límite diario, activar el log de prompts o el envío de firmas, o pasar una opción a la CLI como «modelo». | Regla única: un área de trabajo solo puede hacer ghostline más restrictivo. Lo que decide qué se ejecuta, envía o gasta se lee solo de los ajustes de usuario; exclusiones y lenguajes desactivados se suman; el modelo se valida. |
| S3 | Media | **Las firmas de símbolos (Fase 3) podían llevar secretos**: `export const API_KEY = "sk-…"` en un archivo no excluido se enviaba entero. | Se envía la forma, nunca el valor: se quitan los inicializadores literales y se vacían las cadenas largas. |
| S4 | Media | Las exclusiones por defecto no cubrían carpetas como `secrets/` ni almacenes habituales. | Añadidos `*secret*/**`, `*credential*/**`, `.git-credentials`, `.gnupg`, `.kube`, `.docker/config.json`, `*.tfvars`, `*.tfstate*`, `*.jks`, `*.keystore`, `.htpasswd`. |
| S5 | Media | **Inyección persistente por el perfil de estilo**: lo escribe el modelo a partir de archivos y se repite en cada prompt; un archivo preparado podía hacerle cerrar `</style>` y reescribir la estructura del prompt. | Se eliminan del perfil las etiquetas que estructuran el prompt. Además se abre siempre en un editor para revisarlo. |
| S6 | Baja | Entradas relativas en `PATH` (`.`, `bin`) permitían que un `claude.exe` plantado en un repositorio ganara la búsqueda. | Solo se recorren entradas absolutas, y un shim solo se sigue hasta un archivo llamado `claude.exe`. |
| S7 | Baja | Para archivos de fuera del área de trabajo se enviaba la ruta completa (con el nombre de usuario). | Solo el nombre del archivo. |
| S8 | Baja | El aviso de «estás usando una API key» llegaba después de la primera petición facturada. | Si la variable está en el entorno, se avisa al crear el proceso. |

## Robustez

| # | Hallazgo | Corrección |
|---|---|---|
| R1 | **Sin freno ante errores**: con la CLI sin sesión, sin red o con el límite agotado, cada pausa al teclear lanzaba un proceso nuevo que volvía a fallar. | Cortacircuitos: tras 3 fallos seguidos, pausa de 30 s (doblando hasta 10 min), visible en la barra de estado. La invocación manual no se bloquea y un acierto lo cierra. |
| R2 | Si algo limpiaba la carpeta de trabajo del directorio temporal (la limpieza de otra ventana, por ejemplo), todas las peticiones fallaban con un `ENOENT` engañoso hasta reiniciar. | La carpeta se recrea antes de cada lanzamiento. |
| R3 | **El disparo adaptativo podía silenciarse solo**: una sugerencia que desaparecía porque seguías tecleando contaba como «ignorada», y 40 de esas apagaban el contexto 24 h. | Solo cuenta si estuvo visible al menos 750 ms. |
| R4 | La búsqueda de símbolos se lanzaba en cada pulsación. | Empieza a mitad del debounce. |
| R5 | Una respuesta podía insertarse en una posición antigua si el documento cambiaba durante la petición sin cancelarla. | Se comprueba la versión del documento; la respuesta queda en caché. |
| R6 | La caché de sugerencias sobrevivía a cambios de ajustes (líneas máximas, exclusiones). | Se vacía con cualquier cambio de ajustes. |
| R7 | El estimador de tokens podía quedarse rechazando para siempre un cambio real (otro modelo). | Tras 8 rechazos seguidos adopta el nuevo régimen. |
| R8 | El filtro de explicaciones cortaba frases legítimas en JSX/Vue y en YAML/JSON. | Las frases son válidas tras una etiqueta y en lenguajes de datos y plantillas. |
| R9 | Un `` `texto ${x}` `` donde se esperaba un valor se trataba como markdown y perdía las comillas. | Se respeta el template literal cuando la línea espera una expresión. |
| R10 | Cuatro salidas reales del modelo pasaban el postprocesado (vistas en la medición): razonamiento con la respuesta al final, línea entre comillas invertidas escapadas, sangría escrita como `\s\s\s` y un bloque anterior repetido antes de la línea nueva. | Corregidas, con esas salidas como tests. |
| R11 | Los tests dejaban una carpeta temporal por ejecución; los system prompts podían cambiar de fin de línea al clonar. | Limpieza asíncrona; `.gitattributes` con LF. |

## Riesgos que se aceptan

- **Inyección por el contenido del archivo.** El modelo lee el archivo que editas; un archivo malicioso puede
  influir en lo que sugiere. No tiene herramientas, así que lo único que puede hacer es proponer texto que tú
  aceptas o no con `Tab`. Es inherente a cualquier autocompletado con IA.
- **Los ejemplos guardan código tuyo en claro** en el almacenamiento local de VS Code (las 6 líneas previas y lo
  aceptado). No sale de la máquina salvo como ejemplo en peticiones del mismo proyecto. Se borra con
  *Borrar lo aprendido en este proyecto*.
- **Los documentos sin guardar no tienen ruta**, así que ninguna exclusión los cubre.
- **Enlaces simbólicos**: la exclusión se evalúa sobre la ruta que abre el editor, no sobre su destino.
- **El modelo razona cuando quiere** y a veces se equivoca de sitio (continúa con el código que viene después
  en vez de con la línea que falta). No es un fallo de seguridad; limita el acierto (ver `docs/acierto.md`).

## Verificación

174 tests unitarios y de integración, 20 comprobaciones e2e en un VS Code real (entre ellas: un área de
trabajo con ajustes hostiles, el cortacircuitos y el tiempo mínimo visible), `tsc` y ESLint limpios,
`npm audit` sin avisos.
