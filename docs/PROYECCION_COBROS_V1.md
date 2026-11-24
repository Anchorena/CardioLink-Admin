# Proyección mensual de cobros V1

Estado: **código en la rama `feat/proyeccion-cobros-v1` (sin commit). Sin SQL. QA dirigido en STAGING aprobado (23/11/2026). Production: sin cambios.**

## Qué es
Una vista simple de **ingresos ESPERADOS** por obras sociales y prepagas, solo para **Dueño y Administración** (menú Administrativo → «Proyección de cobros»). Son importes **PROYECTADOS**: **no son dinero cobrado**, no se incorporan a Caja ni a los ingresos efectivamente cobrados y no concilian pagos. La pantalla lo dice en un aviso fijo y rotula cada importe «Proyectado».

## Cómo calcula
- **Fuente:** `cardiolink_presentaciones_os_v1` (cabecera de cada presentación: cobertura, profesional **facturante**, período, cantidad de prestaciones, **total** guardado, fecha de presentación). Solo lectura. En V1 toda fila de esa tabla es una presentación **confirmada** (no hay borrador, anulación ni rectificación).
- **Fecha efectiva de presentación:** `fecha_presentacion` (cierre del día 25). En presentaciones anteriores a ese cierre (columna vacía, o base sin la columna) se usa el **día en que se registró** (`presentado_en`, hora de Buenos Aires), y la tabla lo aclara «(fecha de registro)».
- **Fecha estimada de cobro = fecha efectiva de presentación + plazo de pago de la cobertura** (días corridos).
- **Por mes de cobro estimado:** total estimado; desglose por cobertura (con su plazo), por profesional facturante y por **fecha estimada de ingreso** (cada presentación con su cobertura, facturante, fecha de presentación, plazo, prestaciones e importe); cantidad de presentaciones y de prestaciones.
- **Sin duplicaciones:** cada presentación cuenta una sola vez por su **ID estable** (`id` de la presentación), aunque la lectura la traiga repetida.
- **Sin plazo configurado:** no se proyecta a ningún mes; se informa aparte («Sin plazo configurado (no proyectado)») con su cantidad e importe, para que no quede oculta. Datos incompletos (importe 0, sin cobertura o fecha) se informan como no proyectables.
- **Fechas ya pasadas** se marcan «(ya pasó)»: esta versión **no concilia cobros**, así que no sabe si ese dinero ya ingresó.

## Plazo por cobertura
30, 60, 90 días o **personalizado** (entero de 1 a 365), o «Sin plazo». Se guarda en la **configuración existente** (clave `plazosPagoCobertura`, una entrada por cobertura normalizada: `{ cobertura, dias }`), con la misma vía que el resto de la configuración comercial (confirmación, persistencia verificada y sincronización; si el servidor no lo confirma avisa que quedó solo en ese equipo). **Cambiar un plazo solo recalcula la proyección: no modifica ninguna presentación ni dato histórico.** «Personalizado» sin número es un error (no quita el plazo).

## Qué no hace (V1)
Conciliación bancaria, cobros parciales, reclamos, morosidad, proyección por prestación individual, ni integración con Caja/Finanzas V5. No toca atenciones ni presentaciones; no hay SQL.

## Archivos
`cardiolink-proyeccion-cobros-core.js` (lógica pura), `cardiolink-proyeccion-cobros-v1.js` (sección + lectura paginada + plazos), `cardiolink-proyeccion-cobros-v1.css`, `tests/proyeccion-cobros-v1.js`, y `index.html` (botón de menú, sección, estilos y 2 scripts; **sin tocar `app.js`**).

## Riesgos
- La clave de configuración es nueva y **solo la leen y escriben Dueño y Administración** (la Secretaría no tiene esa clave en su lista autorizada; por eso la vista no se ofrece a Secretaría). Ver QA.
- Es una **estimación**: depende de que el plazo configurado sea el real de cada cobertura; no hay historial de cambios de plazo (solo el valor vigente).
- Sin conciliación, una fecha estimada pasada sigue figurando como proyectada aunque ya se haya cobrado.
