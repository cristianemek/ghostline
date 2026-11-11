# Fase 3 — Contexto de símbolos vía LSP

`ghostline.context.symbols`. Es la única función que envía algo que no está en el documento actual: la
declaración de símbolos definidos en otros archivos. Nació opcional y desactivada; **desde la v0.7.0 está
activada por defecto** y trae también los campos de los tipos (ver el final de esta página). Se apaga con
`"ghostline.context.symbols": false`.

## Qué hace

1. Toma hasta 3 identificadores de la línea actual, los más cercanos al cursor, sin palabras clave, nombres de
   menos de 3 letras, ni palabras dentro de cadenas o comentarios.
2. Pregunta al servidor de lenguaje dónde se definen (`vscode.executeDefinitionProvider`).
3. De cada definición envía solo la firma en una línea (si los parámetros ocupan varias líneas, las une), con
   la ruta del archivo: `export function computeTotal(items: number[], taxRate: number): number  // src/lib.ts`.
4. Se descartan las definiciones que ya están dentro del contexto que se envía, las que no son archivos locales
   y **todas las de archivos excluidos**.

Límites: 3 firmas, 240 caracteres cada una, ~400 tokens en total. El bloque `<symbols>` comparte presupuesto
con el archivo (como los ejemplos), así que el total de la petición no crece cuando el archivo ya lo llena.

La búsqueda se hace **durante el debounce**, con un tope de 300 ms: en modo auto no añade latencia. Si el
servidor de lenguaje tarda más, esa petición sale sin símbolos y la respuesta queda en caché (60 s) para la
siguiente.

## Comprobación con el modelo real

Mismo prompt, con y sin la firma de `applyDiscount(amountInCents, customerTier: 'basic' | 'gold', couponCode?)`,
dos veces cada uno:

| | Tokens de entrada | Sugerencia tras `return applyDiscount(` |
|---|---|---|
| Sin símbolos | 1.090 | `subtotal, order.coupon)` — inventa el segundo argumento |
| Con símbolos | 1.155 (+65) | `subtotal, 'basic')` — respeta los tipos reales |

## Verificación

- Tests unitarios de la selección de identificadores, la extracción de firmas y el formato con su presupuesto.
- Prueba e2e con el servidor de TypeScript real de VS Code: la firma de `src/lib.ts` llega al prompt antes del
  bloque del archivo, y la de `src/secretStore.ts` (excluido por `*secret*`) no llega nunca.
- No se ha medido en lote contra el modelo real: el script `bench` corre fuera de VS Code y no tiene servidor
  de lenguaje.

## v0.7.0: los campos de los tipos, y la línea que abrió la llamada

En uso real (Go, código generado por sqlc) el modelo respondía «nada» justo tras
`gen.CreateConversationParams{`, y en la línea siguiente se inventaba los campos: el struct está en otro
archivo y la línea de firma (`type CreateConversationParams struct`) no los dice.

**No se le da al modelo una herramienta para leer archivos.** Lo lee ghostline:

| | Herramienta de lectura para el modelo | Lo que hace ghostline |
|---|---|---|
| Peticiones a la API por sugerencia | 2 o más (pedir el archivo, leerlo, responder) | 1 |
| Tokens | El prompt entero otra vez por cada vuelta, más el archivo leído | +91 en la prueba de abajo |
| Espera | +0,6 s como poco por cada vuelta | Ninguna: la búsqueda cabe en la pausa de tecleo |
| Qué se lee | Lo que el modelo decida; un comentario en el código podría pedirle un `.env` | Solo la definición que señala el servidor de lenguaje, nunca de un archivo excluido |

Dos cambios:

1. **Declaración con miembros.** Si la definición es un struct, una interfaz, un tipo objeto o un enum **de
   este proyecto**, se envían también sus miembros en una línea: nombres y tipos, nunca valores (se quitan los
   valores de los enum, los valores por defecto y las etiquetas de los struct de Go). Hasta 16 miembros y 480
   caracteres; los cuerpos anidados se pliegan a `{…}`. Las clases y los objetos no cuentan: llevan código y
   valores. De definiciones de fuera del área de trabajo (librería estándar, tipos del lenguaje) se sigue
   enviando solo la línea de firma.
2. **La línea que abrió la llamada o el literal.** Si en la línea del cursor no hay 3 identificadores, se
   buscan también en la línea, hasta 12 más arriba, que dejó abierto el paréntesis, corchete o llave en el que
   está el cursor: `…CreateConversationParams{` cuando estás escribiendo los campos. Una llave que abre un
   bloque de código (`if … {`, `func … {`, `=> {`) no cuenta.

Con la CLI real, sobre el archivo real, el cursor en la línea vacía tras `…CreateConversationParams{`, tres
veces cada uno:

| | Tokens de entrada | Líneas sugeridas | Campos que existen en el struct |
|---|---|---|---|
| Sin símbolos | 1.921 | 2–3 | 3 de 8 (se inventa `ConversationID` e `Identity`) |
| Con símbolos | 2.012 (+91) | 6, las tres veces | 18 de 18 |

Con símbolos, 3 de las 6 líneas eran idénticas a las que se escribieron a mano; las otras tres tenían el campo
correcto con un valor más simple (`in.Timezone` donde iba `cmp.Or(in.Timezone, …)`).

Prueba e2e: con el servidor de TypeScript real, el cursor en la línea vacía de
`export const options: ReportOptions = {` lleva al prompt
`export interface ReportOptions { title: string; taxRate: number; currency?: string }  // src/lib.ts`.
