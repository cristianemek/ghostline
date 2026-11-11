# Latencia: dónde se va el tiempo y qué se puede recortar

Medido el 11-nov-2026 con la CLI real (Claude Code 2.1.322, `claude-haiku-5-5`, `effort low`).

## Anatomía de una petición

Tiempos desde que se escribe el mensaje en el proceso (ya arrancado) hasta cada hito, con un prompt típico
de ~1.950 tokens y una respuesta de ~45:

| Hito | Proceso de un solo uso | Proceso persistente (2.º turno en adelante) |
|---|---|---|
| La CLI envía la petición a la API | ~85 ms | ~20 ms |
| **Primer token del modelo** | **640–750 ms** | 500–700 ms |
| Respuesta completa (~45 tokens) | 830–970 ms | 650–930 ms |
| La CLI entrega el resultado | +12 ms | +8 ms |

- **El suelo lo pone el modelo**: ~550 ms hasta el primer token, más ~4 ms por token de respuesta. La CLI
  añade ~100 ms en total.
- El tamaño del prompt no mueve la aguja en este rango (163 caracteres: 680 ms hasta el primer texto;
  2.342 caracteres: 620–760 ms).
- Mantener la conexión abierta (proceso persistente) no acelera el primer token; solo ahorra los ~65 ms de
  preparación de la CLI.
- Cuando el modelo decide razonar (una de cada cuatro peticiones), el primer token llega a los 2–3 s. No se
  puede desactivar (ver `docs/fase-1.md`).

**Una sugerencia nueva no puede bajar de ~0,85 s con este modelo y esta vía.** Los 130–300 ms de un
autocompletado con modelo propio no son alcanzables a través de la CLI de Claude Code.

## Lo que se probó y no sirve

| Idea | Resultado |
|---|---|
| Proceso persistente limpiando la conversación con `/clear` entre peticiones | Funciona una vez (coste constante: 2.082 tokens tras limpiar frente a 1.955) y ahorra ~65 ms, pero el proceso dejó de responder en la tercera petición. Descartado. |
| Apostar también dentro de la línea, tras `.`, `(`, `=`… (nivel `eager`) | 2,2x tokens y la misma espera mediana que sin apostar. Eliminado. |
| Pedir de nuevo al instante cuando la petición en curso no coincide | Encadenaba 3–5 peticiones por línea (3,7x tokens). Corregido: se respeta la pausa. |
| Reducir el prompt | Sin efecto en el primer token. |
| «Fast mode» de la CLI | Acelera la generación, no el primer token, y la respuesta son ~40 tokens. |

## Lo que sí recorta la espera (v0.5.0)

Todo ocurre alrededor de la petición, no dentro:

1. **La petición en curso ya no muere con la siguiente tecla.** Si lo que tecleas coincide con lo que el modelo
   va respondiendo, se usa esa respuesta: aparece cuando aterriza, sin lanzar otra petición ni volver a
   esperar. Se descarta en cuanto diverge, si pasa 1 s sin decir nada (está razonando) o si mueves el cursor.
2. **Una respuesta que llega mientras tecleas** se guarda y se le pide al editor que la muestre en ese momento.
3. **Sin espera tras aceptar** una sugerencia: la siguiente se pide al instante.
4. **Una apuesta por línea nueva**: en una línea vacía la espera es corta (120 ms, o 1,6 veces tu ritmo de
   tecleo si es más) en vez de 350 ms. Si empiezas a teclear lo que el modelo predijo, la sugerencia está en
   pantalla antes de que pares.
5. Con texto detrás del cursor en la misma línea, la respuesta se corta en la primera línea.

## Cuánto mejora y cuánto cuesta

`npm run bench:typing` teclea de nuevo, tecla a tecla, 8 líneas reales (pausa de 420 ms al empezar la línea,
~95 ms por tecla, ~230 ms tras espacio o puntuación) y para a un tercio de la línea. Mide lo que notas: el
tiempo desde la última tecla hasta que hay sugerencia.

| `ghostline.speculation` | Espera mediana | Mejor caso | Tokens de entrada por línea |
|---|---|---|---|
| `off` (comportamiento original) | 1.666 ms | 1.289 ms | 1.908 |
| **`line`** (por defecto) | **1.281 ms** | **0 ms** (ya en pantalla) | 3.565 |

Una tanda anterior, con otra latencia de la API ese rato, dio 1.270 → 912 ms. En ambas: **un 23–28 % menos de
espera mediana, y entre una y tres de cada ocho líneas con la sugerencia ya puesta o en medio segundo, a
cambio de ~1,9x tokens** (cada apuesta que no acierta es una petición pagada).

Con 8 líneas por tanda y la variación de la API, las diferencias de ±300 ms en una línea concreta son ruido;
lo estable es el patrón: cuando la apuesta acierta, la espera desaparece; cuando no, es la de siempre.

## Qué elegir

- **Menos espera** (por defecto): `"ghostline.speculation": "line"`.
- **Menos tokens**: `"ghostline.speculation": "off"`. Es exactamente el comportamiento de la v0.4.
- `ghostline.debounceMs` (350) sigue mandando dentro de la línea: bajarlo a 200 resta 150 ms a cada
  sugerencia nueva y lanza más peticiones. `ghostline.eagerDebounceMs` (120) es la espera en línea vacía.
- El modo manual (`Alt+\`) no tiene espera: es petición directa, ~0,85 s.
