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
