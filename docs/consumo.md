# Consumo real: primera sesión de uso (v0.5.0) y qué cambió en la v0.6.0

Datos del log de ghostline y de sus contadores, 11-nov-2026, unos 3 minutos editando un proyecto en Go.

## Qué pasó

| | Peticiones | Tokens de entrada |
|---|---|---|
| Perfil de estilo (una vez, a petición) | 1 | 6.312 |
| Sugerencias que llegaron a responder | 7 | 13.212 |
| Canceladas después de que el modelo empezara | 4 | 7.207 |
| Canceladas antes de que el modelo dijera nada | 7 | no informado por la CLI |
| **Total contado** | **19** | **26.731** |

De las 7 que respondieron: 3 aceptadas, 2 ignoradas, 2 vacías. Coste equivalente en la API de toda la sesión:
0,0038 $. Cada petición ronda los 1.900 tokens por diseño (unos 1.000 son fijos: la CLI y el system prompt).

## Dónde se desperdiciaba

1. **Una regla de «paciencia» mía mataba peticiones a punto de responder.** Si una petición reaprovechada no
   decía nada en 1 s, se abandonaba. En las pruebas el primer token llegaba a los 0,65 s; en uso real, a los
   1,1 s. Tres peticiones murieron entre los 993 y los 996 ms.
2. **Se apostaba en cada línea nueva** (`speculation: line`): una petición más por línea, pagada aunque no
   coincida con lo que luego tecleas.
3. **350 ms de pausa lanzaban peticiones a mitad de escribir**, que luego se cancelaban.
4. **Las peticiones cortadas antes de responder no se contaban**: la CLI no informa de su consumo, pero ya
   habían salido hacia la API. El contador real era mayor que el mostrado.
5. **El modo `minimal` acertaba poco** (≈32 % frente a ≈52 % dejando razonar), así que cada sugerencia buena
   salía cara: unas 6.800 tokens por aceptada en esta sesión.

## Qué cambia en la v0.6.0

| Antes | Ahora | Efecto |
|---|---|---|
| `reasoning: minimal` | `reasoning: adaptive` | Más aciertos; la mitad de coste por sugerencia buena; algunas tardan 2–3 s. |
| `speculation: line` | `speculation: off` | Sin apuestas: solo se pide tras una pausa de verdad. |
| `debounceMs: 350` | `debounceMs: 600` | Menos peticiones a mitad de escribir. |
| Paciencia de 1 s | Eliminada | Una petición enviada se deja terminar. |
| La siguiente tecla podía matar la petición | Se aprovecha mientras lo tecleado coincida | Lo ya pagado no se tira. |
| Las cortadas no contaban | Se anotan aparte como «sin confirmar» | El tooltip enseña el consumo posible, no solo el confirmado. |

## Si quieres gastar aún menos

- **Modo manual**: `ghostline.triggerMode: "manual"` y `Alt+\`. Solo se pide cuando tú lo dices; ninguna
  petición se queda sin usar.
- **Pausa más larga**: `ghostline.debounceMs: 900`.
- **No regenerar el perfil de estilo** salvo que cambie el proyecto: son ~6.000 tokens cada vez.
