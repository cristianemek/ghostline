# Correcciones: reescribir lo que ya está escrito (v0.11.0)

Hasta la v0.10 ghostline solo insertaba en el cursor. Un snippet con sus huecos (`switch expression { case
condition: }`) o una llamada con un argumento de más se quedaban como estaban.

## Cuándo se pide una corrección

Automáticamente, cuando se cumple todo esto:

- el compilador (el servidor de lenguaje) marca **errores** a 6 líneas o menos del cursor;
- llevas **1,5 s** sin teclear, sin mover el cursor y sin que cambien los diagnósticos;
- no hay una sugerencia en pantalla ni en camino;
- ese código no lo has tecleado a mano en los últimos 6 s: mientras se escribe, el código está lleno de
  errores que no son equivocaciones. Un snippet o un texto pegado sí cuentan desde el primer momento;
- por ese mismo código con esos mismos errores no se ha preguntado ya.

Lo que se reescribe es **la región**: de la primera a la última línea con error, alargada hacia abajo hasta
que se cierran los paréntesis y llaves que abre, para que sea una sentencia o un bloque entero. Si pasa de 12
líneas, o no se puede recortar limpiamente, no se pregunta.

Respeta lo mismo que las sugerencias: modo manual, pausa, tope diario, lenguajes desactivados y archivos
excluidos. Se apaga con `"ghostline.corrections": false`.

## Qué se le manda al modelo

El mismo archivo que en una sugerencia, con la región donde iría el cursor, lo que dice el compilador y, al
final, la orden:

```
<file path="api/core.go" language="go">
<prefix>…</prefix><region>
	switch expression {
	case condition:

	}
</region><suffix>…</suffix>
</file>
<fix>
The compiler reports, inside <region>:
- line 1: undefined: expression
- line 2: undefined: condition
</fix>
Write the 4 lines of <region> again, from the first line's first character to the end, with these errors fixed.
```

Va por el mismo proceso y el mismo prompt de sistema que las sugerencias (con el índice del proyecto en caché).

## Qué se hace con la respuesta

No se muestra si no es código, si es lo mismo que había, si crece más de 8 líneas, si deja un paréntesis o una
llave sin cerrar, o si no empieza como empezaba la región (señal de que el modelo ha devuelto un trozo de la
línea en vez de la línea). Cuando llega, el código tiene que seguir siendo el mismo que cuando se pidió.

Se enseña sobre el propio código: las líneas que cambian, tachadas; lo que las sustituye, a continuación y en
gris (`→ switch { ⏎ case streamErr != nil: ⏎ …`); al pasar el ratón, el bloque completo. `Tab` la aplica y
`Esc` la descarta; también se descarta al teclear, al deshacer o al llevar el cursor a otra parte. No es texto
fantasma porque la API estable de VS Code solo admite que una extensión proponga inserciones.

## Medido con la CLI real

Los dos casos que lo motivaron, sobre el archivo real y con el índice del proyecto:

| | Haiku `effort: medium` | Sonnet `effort: low` |
|---|---|---|
| Snippet `switch expression { case condition: }` en `finishMessage` | 4 de 4 | 3 de 4 mostradas y correctas |
| `ListContextMessages(ctx, conversationID, nil)` (sobra un argumento) | 4 de 4 | 4 de 4 |
| Tiempo | 1–4 s | 1–6 s |
| Coste por corrección | 0,0001–0,0004 $ | 0,001–0,008 $ |

- Haiku propone `switch { case streamErr != nil: status = gen.MessageStatusFailed }`. Sonnet llega más lejos
  (`case errors.Is(streamErr, context.Canceled): status = gen.MessageStatusInterrupted`), y en una de las
  cuatro convirtió el `switch` en un `if`, que se descartó por no empezar como la región.
- **La orden final es lo que lo hace funcionar con Haiku.** Sin la última línea del mensaje, Haiku respondía
  como si completara en un cursor (`ctx, conversationID, nil)`, medio renglón): 1 de 6. Con ella, 8 de 8.
- **Las constantes de Go** entraron en el índice del proyecto por esta prueba: sin verlas, Sonnet escribió
  `gen.MessageStatusCancelled`, que no existe.

Son dos casos y pocas repeticiones. Lo que no está medido es cuántas veces propondrá algo que no hace falta:
código a medias que tiene errores porque falta escribir lo que viene después. Las entradas quedan en *ghostline:
Ver las últimas sugerencias* como «corrección», con lo que se propuso y lo que respondió el modelo.

## Verificación

Tests unitarios de la región, el prompt, la validación de la respuesta y el cálculo de lo que cambia. Prueba
e2e con el servidor de TypeScript real: con errores junto al cursor se propone el bloque, descartarlo no vuelve
a preguntar por lo mismo, y aceptarlo deja el archivo corregido. No he podido ver cómo queda dibujado en tu
editor (tachado y texto gris): eso solo se ve usándolo.
