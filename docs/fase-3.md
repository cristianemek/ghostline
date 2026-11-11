# Fase 3 — Contexto de símbolos vía LSP

Opcional y **desactivada por defecto** (`ghostline.context.symbols`), porque es la única función que envía
algo que no está en el documento actual: la línea de firma de símbolos definidos en otros archivos.

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
