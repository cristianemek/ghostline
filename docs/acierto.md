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

## Calidad frente a coste (mismas 24 muestras, v0.6.0)

| Configuración | Idénticas | Coste por petición | p50 / p95 | Coste por sugerencia idéntica |
|---|---|---|---|---|
| Haiku · `reasoning: minimal` | 5 (21 %) | 0,000209 $ | 1.031 / 1.808 ms | 0,00100 $ |
| **Haiku · `reasoning: adaptive`** (por defecto) | **13 (54 %)** | 0,000252 $ | 1.026 / 2.583 ms | **0,00047 $** |
| Haiku · `adaptive` · `effort: medium` | 12 (50 %) | 0,000289 $ | 1.445 / 3.662 ms | 0,00058 $ |
| Sonnet · `adaptive` | 15 (63 %) | 0,003724 $ | 1.041 / 1.214 ms | 0,00596 $ |

Sumando todas las tandas hechas durante el desarrollo: `adaptive` 35 de 68 (51 %), `minimal` 40 de 124 (32 %).
Una de las comparaciones salió empatada (7 frente a 8 de 20) y fue la que llevó a elegir `minimal` en la v0.1,
cuando la prioridad era la latencia; con más datos, fue la excepción.

- **Dejar razonar al modelo es lo que más mejora el resultado**: +20 puntos de acierto por un 20 % más de coste
  por petición, que sale a la mitad por sugerencia buena. A cambio, una de cada cuatro peticiones tarda 2–3 s.
- **Más esfuerzo (`medium`) no compra nada**: mismo acierto, más tokens de razonamiento y más espera.
- **Sonnet acierta algo más y es muy regular** (no razona, nunca devolvió vacío), pero cuesta unas 15 veces
  más por petición. Solo tiene sentido si el consumo no importa: `"ghostline.model": "sonnet"`.

## Casos reales que salían mal (v0.9.0)

Cuatro sugerencias de una sesión real en Go (código generado por sqlc), reproducidas contra la CLI real con el
archivo, las declaraciones y los ejemplos guardados en aquel momento (`n` = repeticiones de cada caso):

| | Cursor | Lo correcto |
|---|---|---|
| A | `c.queries.ListContextMessages(▮)` | `ctx, conversationID` (la función tiene 2 parámetros; se sugirieron 3) |
| B | `_, err = c.queries.CreateMessage(▮)` | `ctx, gen.CreateMessageParams{…` |
| C | `messages▮ c.queries.ListContextMessages(ctx, conversationID)` | `, err :=` (se sugirió `= ghostline Model`) |
| D | `conversation, ▮c.queries.CreateConversation(ctx, …` | `err := ` |

**1. Los ejemplos aceptados perjudicaban.** Con la declaración en el prompt, añadir los dos ejemplos «parecidos»
bajó los aciertos de 10 de 15 a 3 de 15 (A, B y C, prompt anterior). Uno de los ejemplos era otra llamada mal
completada que se había aceptado con Tab y corregido después a mano: aceptar no es dar por bueno. Desde la
v0.9.0 los ejemplos están desactivados por defecto (además ahorra ~240 tokens por petición) y, si se activan,
una sugerencia solo se guarda si su texto sigue en el archivo 10 minutos después.

**2. El esfuerzo importa en las llamadas** (A y B, prompt final, con la declaración, n = 8):

| `ghostline.effort` | Aciertos | Coste por petición | Latencia media |
|---|---|---|---|
| `low` | 7 de 16 | 0,00028–0,00041 $ | 1,6–2,8 s |
| **`medium`** (por defecto desde la v0.9.0) | **14 de 16** | 0,00031–0,00047 $ | 1,7–3,3 s |
| `high` | 13 de 16 | 0,00031–0,00059 $ | 1,7–4,3 s |

Con `low` el modelo muchas veces no razona y copia la forma de lo que tiene alrededor; con `medium` razonó
las 16 veces. (En la prueba de líneas al azar de más arriba `medium` no había aportado nada; aquí, donde hay
que respetar una declaración, sí.)

**3. En mitad de una línea, pedir la línea entera.** Pidiendo «el texto que falta en el cursor», el modelo
respondía cosas como `= ghostline-cwd` (el nombre de la carpeta de trabajo de la CLI, que la CLI le cuenta) o
se ponía a deliberar dentro de la respuesta. Pidiéndole la línea completa tal como debe quedar, y deduciendo
la inserción por diferencia, acierta; y lo que no conserva los dos lados del cursor se descarta en vez de
mostrarse (C y D, n = 8):

| | Pidiendo la inserción (C) | Pidiendo la línea entera (C y D) |
|---|---|---|
| Haiku `low`, con declaración | 0 de 8 | 12 de 16 |
| Haiku `medium`, con declaración | 2 de 8 | **16 de 16** |
| Haiku `medium`, sin declaración | — | 13 de 16 (los otros 3, descartados) |

Para estos casos la búsqueda de símbolos mira también los identificadores **después** del cursor: para nombrar
lo que devuelve una llamada hay que saber qué devuelve.

**4. Sonnet es más regular, y unas 12 veces más caro.** Mismo prompt, `effort: low`: A 6 de 6, B 6 de 6, C y D
(línea entera) 16 de 16, sin razonar, ~1,1 s y unos 0,0045 $ por petición. `"ghostline.model": "sonnet"` si la
regularidad importa más que el consumo.

**5. Filtros nuevos** para lo que el modelo añade alrededor del código, todos vistos en uso real o en estas
pruebas: un bloque entre comillas invertidas simples, la llave de un literal de Go escrita de nuevo
(`…Params{` + `{ConversationID: …`), una etiqueta de cierre suelta (`ctx, conversationID</parameter>`), las
etiquetas del propio prompt, y el modelo dudando de lo que acaba de escribir (`status := ... no; the function
ends…`, `"log slog.Error"? No —`): en ese caso no se ofrece nada.

Las cifras son de pocos casos y pocas repeticiones (el modelo no responde igual dos veces); sirven para elegir
entre opciones con diferencias grandes, no para afinar. *ghostline: Ver las últimas sugerencias* enseña qué se
ofreció de verdad, qué respondió el modelo y qué pasó con ello.

## Qué más mueve el acierto

- **El razonamiento**, como muestra la tabla: cuando el modelo razona (200–500 tokens, 2–3 s) casi siempre
  acierta; cuando contesta directo, acierta menos.
- **Las firmas de símbolos** (`ghostline.context.symbols`): en la prueba puntual, con 65 tokens más el modelo
  dejó de inventarse los argumentos de una llamada. Atacaría justo el grupo de «se inventó la forma».
- **El perfil de estilo y los ejemplos**: sin efecto medible en esta prueba (6–7 de 20 con y sin ellos). El
  perfil llegó a empeorarla (3 de 20) cuando le quitaba sitio al código del archivo; por eso solo se envía
  cuando cabe.
- **La posición**: «línea nueva» obliga a adivinar qué línea falta entre lo de antes y lo de después, que no
  es lo habitual al programar (normalmente escribes al final de lo que hay). En uso real debería ir mejor que
  en esta prueba, pero eso solo lo dirá tu porcentaje de aceptadas.
