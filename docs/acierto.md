# Cuánto acierta

## Cómo se mide

`npm run bench -- --n 40 --verbose` toma líneas al azar del código de este repositorio (que el modelo no ha
visto nunca), borra una y le pide a ghostline que la complete con el mismo pool, prompt y postprocesado que la
extensión. La mitad de los casos son **línea nueva** (se borra la línea entera) y la otra mitad **mitad de
línea** (se deja el principio, hasta un `=`, `(` o `.`). Se compara la primera línea sugerida con la original:

- **idéntica**: carácter por carácter;
- **casi**: empieza igual en al menos el 60 % de la línea, o es la línea correcta a medias;
- **distinta** o **vacía**.

Es una vara dura: una sugerencia perfectamente válida con otro nombre de variable cuenta como distinta. La
cifra que importa de verdad es el porcentaje que aceptas trabajando, que la barra de estado muestra a diario.

## Resultado (Haiku 5.5, `effort low`, `reasoning: minimal`, sin aprendizaje)

| Tanda | Idénticas | p50 / p95 | Entrada (mediana) |
|---|---|---|---|
| 20 peticiones | 8 (40 %) | 868 / 1.713 ms | 1.933 |
| 20 peticiones | 6 (30 %) | 1.045 / 2.886 ms | 1.889 |
| 40 peticiones | 13 (33 %) | 940 / 2.110 ms | 1.892 |
| **Total: 80** | **27 (34 %)** | | |

Desglose de la tanda de 40:

| | Idéntica | Casi | Distinta | Vacía |
|---|---|---|---|---|
| Línea nueva (20) | 6 | 0 | 13 | 1 |
| Mitad de línea (20) | 7 | 1 | 12 | 0 |

Las 25 «distintas», una a una:

| Qué pasó | Casos | Ejemplo |
|---|---|---|
| Equivalente o casi: misma forma, otro nombre o texto | 6 | `some((key) => …)` por `some((name) => …)` |
| Se escapó al postprocesado (**ya corregido**) | 4 | razonamiento con la respuesta al final; línea entre comillas invertidas |
| Siguió con el código de después en vez de con la línea que falta | 6 | escribió el cuerpo de la función donde iban los parámetros |
| Se inventó la forma de una llamada o un campo | 4 | `examples.add({ … })` cuando recibe tres argumentos |
| Token equivocado | 5 | `(): boolean {` donde iba `): boolean {` |

Reaplicando el postprocesado corregido a esas mismas respuestas, dos pasan a idénticas: 15 de 40 (38 %).
Sumando las equivalentes, en torno a la mitad de las sugerencias eran utilizables tal cual o con un retoque.

## Qué mueve el acierto

- **El razonamiento.** Cuando el modelo razona (200–500 tokens, 2–3 s) casi siempre acierta; cuando contesta
  directo, acierta menos. `reasoning: adaptive` no mejoró la media en la comparación A/B (7 de 20 frente a 8 de
  20) y cuesta un 13 % más y 0,7 s más de mediana.
- **Las firmas de símbolos** (`ghostline.context.symbols`): en la prueba puntual, con 65 tokens más el modelo
  dejó de inventarse los argumentos de una llamada. Atacaría justo el grupo de «se inventó la forma».
- **El perfil de estilo y los ejemplos**: sin efecto medible en esta prueba (6–7 de 20 con y sin ellos). El
  perfil llegó a empeorarla (3 de 20) cuando le quitaba sitio al código del archivo; por eso solo se envía
  cuando cabe.
- **La posición**: «línea nueva» obliga a adivinar qué línea falta entre lo de antes y lo de después, que no
  es lo habitual al programar (normalmente escribes al final de lo que hay). En uso real debería ir mejor que
  en esta prueba, pero eso solo lo dirá tu porcentaje de aceptadas.
