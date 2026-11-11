# Fase 2 — Aprender sin entrenar: cifras y decisiones

Todo lo que ghostline aprende se guarda **solo en local** (almacenamiento de VS Code) y nunca procede de
archivos excluidos, porque en ellos no llega a existir una sugerencia.

| Apartado de la spec | Implementación | Dónde se guarda |
|---|---|---|
| a) Feedback | Aceptada: el `command` del item (o teclear la sugerencia entera). Ignorada: llega otra petición o el cursor se mueve sin editar. Solo API estable. | — |
| b) Ejemplos | Últimas 200 aceptadas por lenguaje (5 líneas previas + la actual, y el texto aceptado). En cada petición, hasta 2 parecidas por Jaccard sobre identificadores (umbral 0,12), máx. ~300 tokens. | `workspaceState` |
| c) Perfil de estilo | Comando *Aprender estilo del proyecto*: propone hasta 5 archivos, los confirmas en una lista, Claude escribe una guía de ≤ 120 palabras y se abre en un editor. Se relee al guardar. | Archivo en el almacenamiento privado del workspace |
| d) Disparo adaptativo | Por lenguaje y contexto (tras `.`, tras `(`, línea nueva, final de línea): si de las últimas 40 automáticas se acepta menos del 10 %, silencio de 24 h con aviso. El manual ni cuenta ni se ve afectado. | `globalState` |
| e) Aviso de velocidad | Con 20+ peticiones y p50 > 1.500 ms: un aviso al día con dos botones, *modo manual* o *reducir el contexto* (lo deja a la mitad). | `globalState` |

Comandos nuevos: *Aprender estilo del proyecto*, *Editar el perfil de estilo del proyecto* y *Borrar lo
aprendido en este proyecto*. El tooltip de la barra de estado muestra ejemplos guardados, si hay perfil y los
contextos silenciados; la línea de log de cada petición indica qué se añadió (`[+estilo, 2 ej.]`).

## Medidas (CLI real, 20 peticiones por tanda)

Generar el perfil de este repositorio: 5 archivos, **5.771 tokens de entrada**, 350 de salida, 3,2 s,
0,00075 $ equivalentes. Resultado: 8 viñetas (680 caracteres, ~215 tokens) que describen bien el código
(2 espacios, comillas simples, `import type`, constantes en `UPPER_SNAKE_CASE`…).

| Tanda | Entrada (mediana) | p50 / p95 | Coste por petición | Primera línea idéntica |
|---|---|---|---|---|
| Sin aprendizaje | 1.889 | 1.045 / 2.886 ms | 0,000253 $ | 6 / 20 |
| Solo ejemplos | 1.931 | 1.117 / 2.901 ms | 0,000236 $ | 7 / 20 |
| Perfil **sumado** al contexto + ejemplos | 2.162 | 1.225 / 2.408 ms | 0,000254 $ | 7 / 20 |
| Perfil **a costa** del contexto + ejemplos | 1.942 | 1.122 / 2.044 ms | 0,000230 $ | 3 / 20 |

Las tandas no son idénticas entre sí (el modelo razona o no de forma aleatoria y las muestras cambian con el
código), así que diferencias de ±150 ms o ±2 aciertos son ruido. Lo que sí se ve:

- **El perfil no mejora las sugerencias cuando el archivo ya llena el presupuesto**: el código que rodea al
  cursor ya enseña el estilo. Sumado cuesta ~230 tokens más por petición (la mediana pasa de 2.000); si en su
  lugar se le quita sitio al archivo, las sugerencias empeoran.
- Los ejemplos apenas pesan: en esta prueba solo 3 de 20 peticiones encontraron uno parecido.

## Decisiones

1. **El perfil de estilo solo se envía cuando cabe sin recortar el archivo.** En archivos nuevos o cortos, que
   es donde no hay código del que deducir el estilo, va el primero (bloque estable). En archivos largos se
   omite. Así la mediana de entrada se queda por debajo de 2.000 y no se pierde calidad.
2. **Los ejemplos sí comparten presupuesto** (son específicos del punto donde está el cursor): recortan el
   prefijo por arriba, pero el archivo conserva siempre al menos el 60 % del presupuesto.
3. **El bloque estable no aprovecha la caché de prompts**, porque en modo `single-use` está desactivada
   (hallazgo 4 del Paso 0). Se mantiene el orden que pide la spec por si se usa el modo `persistent`.
4. La petición de estilo usa un presupuesto de 5.200 tokens de archivos (≈ 6k en total con la sobrecarga de la
   CLI) y no cuenta en las estadísticas de latencia de las sugerencias, aunque sí en los tokens del día.
5. Teclear a mano una sugerencia entera cuenta como aceptada, también para los ejemplos.

## Verificación

154 tests unitarios y de integración, y 16 comprobaciones e2e en un VS Code real, 4 de ellas de esta fase:
lo aceptado aparece como ejemplo en código parecido, el perfil se genera y va primero en el prompt, un archivo
excluido nunca se envía al aprender el estilo, y tras 40 sugerencias ignoradas el contexto se silencia sin
afectar al modo manual ni a otros lenguajes.
