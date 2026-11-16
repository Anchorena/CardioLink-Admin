# Pendientes de cobro V1 — QA dirigido y automatizado en STAGING

Última actualización: 2026-11-16 · Guard v4.2.1 (`docs/propuestas/pending_review_cobros_v1_guard_v421*.sql`)

Alcance: validar en **STAGING** (`yslhwdlzdknhskawqrtv`) el guard v4.2.1 y el frontend integrado. **Production
(`tupacclmhaqiahhlttyz`) no se toca**: ni SQL, ni frontend, ni datos. Solo cuentas y datos ficticios; no se desactivan
triggers, políticas ni controles para que una prueba pase; no se usa `service_role` para demostrar permisos de usuarios
comunes. Si una prueba da FAIL se detiene el QA y no se avanza a Production.

## 0. Cuentas ficticias (solo STAGING)
Direcciones `qa-cobros-*@cardiolink-qa.test`, creadas con la API de administración de Auth (credencial privilegiada usada
únicamente para aprovisionar y borrar usuarios) y su perfil en `cardiolink_user_roles`: médico A (`humberto_drago`),
médico B (`lucas_drago`), Secretaría asociada a A, Secretaría asociada a B, Secretaría NO asociada, admin y owner. Las
asociaciones se crean con la RPC real `cardiolink_asociar_secretaria_medico_v1` ejecutada por el admin QA. Contraseñas
generadas al azar, en un archivo local protegido fuera del repositorio; nunca en logs, informes ni capturas. Todas las
pruebas funcionales y de permisos usan el login real de cada cuenta. Al terminar: borrar registros sintéticos, asociaciones,
perfiles y cuentas, y comprobar que sus sesiones ya no operan.

## 1. SQL en STAGING (CLI de Supabase con `--linked --project-ref yslhwdlzdknhskawqrtv`)
Orden obligatorio:
1. `..._v421_checks.sql` ANTES (consultas 1 a 8). Consulta 1: `estado_inferido` = `v4.1.1` (cuerpo formateado o compacto);
   cualquier otro md5 → `desconocido` → no continuar. Consulta 3: las 4 dependencias en `existe`, `security_definer` y
   ejecutables por `authenticated`. Consulta 4: predicado RLS vigente. Consulta 5: asociaciones.
2. `..._v421.sql`. Aborta sin cambios si algo no coincide. Registra `estado_previo` y `md5_previo` en el `COMMENT`.
3. Verificar: consulta 1 = `v4.2.1`; 3 triggers con `tgenabled = 'O'`; políticas RLS, grants y ACL idénticos a un snapshot previo.
4. `..._v421_tests.sql` (termina en `ROLLBACK`): 0 FAIL; las 28 originales y los casos nuevos; un 42501 cuenta como guard solo si el
   mensaje empieza con "Rol no autorizado" (un rechazo de la RLS se informa como `42501-RLS`). Sin residuos ni asociaciones.
5. `python3 docs/propuestas/pending_review_cobros_v1_guard_v421_concurrencia.py`: dos sesiones reales sobre la tabla real (C1
   resurrección, C2 upserts legítimos concurrentes sin deadlock, C3 alta legítima tras borrado concurrente).
6. Ensayo de rollback: `..._v421_rollback_a_staging_v411.sql` debe devolver STAGING a un estado idéntico (función, comentario, ACL,
   triggers, políticas) al snapshot previo; reaplicar `..._v421.sql`. El rollback B no se ejecuta en STAGING.

## 2. API real (PostgREST con el JWT de cada cuenta)
Médico (alta pendiente/cobrada/No cobrar, falsificación por INSERT, confirmar, borrar, edición asistencial, upsert de sincronización
legítimo y con copia vieja), Secretaría asociada (confirmación legítima con identidad/email/fecha/auditoría verificados; email, nombre,
PorId, rol, fecha y auditoría falsos; reconfirmar; flujos administrativos), Secretaría NO asociada (confirmar, modificar o mover un
confirmado, borrar; operaciones administrativas y altas permitidas), owner/admin (confirmación con su identidad; rol, PorId, email o
nombre falsos; reescribir identidad o fecha de una confirmación; auditoría agregada a su nombre y a nombre de otro), destinatario
económico distinto de quien atiende y `cajaPerfil` ausente, y concurrencia (doble confirmación en una sesión y en dos, cambio concurrente
de importe y de `cajaPerfil` con `updated_at`).

## 3. Navegador (Playwright con Chromium sobre una COPIA del frontend en `127.0.0.1`)
La copia (fuera del repositorio) solo cambia las dos primeras líneas de `app.js` (URL y clave pública de STAGING); `app.js` del
repositorio no se modifica. El contexto del navegador bloquea explícitamente el dominio de Production y se registra cada host
contactado. Casos: 1 alta con cobro pendiente; 2 confirmación; 3 no duplicación; 4 fechas (Caja y Finanzas V5 por fecha de cobro,
Listado y producción por fecha de atención); 5 cambio de `cajaPerfil` con panel desactualizado; 6 confirmación simultánea; 7 "No
cobrar"; 8 pendiente de bono distinto de pendiente de cobro; 9 permisos de interfaz coherentes con la API; 10 atenciones históricas;
11 regresión de Finanzas V5 (totales, egresos, comparación independiente con la base); 12 persistencia, consola y red. Todos los
importes y fechas se verifican contra la base de datos real, no solo contra la pantalla.

## 3b. QA del arranque de la sincronización (caso 12b)
Ejecutado con Playwright contra dos copias del frontend (código anterior y nuevo), con cuentas ficticias y datos sintéticos:
A reproducción del fallo original; B a E la Secretaría confirma mientras el admin reabre con caché obsoleta (cobro intacto, sin duplicar
Caja, sin aviso); F a H cambios legítimos, locales y sincronización normal; I reparación de corruptos; J rechazos de seguridad vigentes;
K regresiones; L arranque con caché obsoleta (ninguna escritura antes de la primera carga y del baseline); M Supabase lento (lectura
demorada 7 s); N primera carga fallida y recuperación; O bootstrap `forzar=true` con remoto vacío (escritura interceptada); P cola de
respaldo; Q persistencia de configuración; R todos los roles; S campos no financieros obsoletos; T liberación del bloqueo.

## 4. Tests locales con Node real
`node --test cardiolink-cobros-v1.test.cjs` y `node tests/finanzas-v5-*.js` (6 suites, incluida `seguridad-local`). Node portable LTS
descargado de nodejs.org con SHA-256 verificado, en una carpeta temporal (sin instalación global ni cambios de PATH).

## 5. Cierre del QA y paso a Production
STAGING aprobado solo con 0 FAIL, sin bloqueantes de seguridad o integridad financiera y sin pruebas obligatorias sin ejecutar.
Después, con autorización explícita:
1. `..._v421_checks.sql` en Production (solo lectura): `estado_inferido` esperado `sin_guard`. Si no lo es, no se aplica.
2. Aplicar `..._v421.sql` (instalación nueva) y repetir los checks (`v4.2.1`).
3. Rollback de Production: `..._v421_rollback_b_production_sin_guard.sql` (solo si `estado_previo=sin_guard`).
4. Publicar el frontend integrado (no antes del guard, para que ningún médico use la ventana sin protección).
5. Verificar en Production que existen asociaciones activas para las Secretarías (sin ellas ninguna confirma) y revisar la consulta 7
   de los checks (destinatarios económicos sin `professional_id`).
