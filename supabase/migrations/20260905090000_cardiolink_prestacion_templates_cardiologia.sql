-- CardioLink Admin - Patient Communications V1: contenido por prestación
-- (actividad cardiológica actual)
--
-- REDACTADA, NO EJECUTADA TODAVIA (ni en Staging ni en Production).
--
-- Migracion de CONTENIDO, no de esquema: no crea columnas, no crea tablas,
-- no toca ningun CHECK. Unico cambio: filas de
-- public.cardiolink_prestacion_templates (ya existente desde
-- 20260828120000_cardiolink_communications_schema.sql). Se versiona como
-- migracion (en vez de editarse a mano en el SQL Editor) para que quede
-- trazado en git igual que el resto de los cambios de este cierre - la
-- tabla en si sigue sin pantalla de administracion propia (ver docs/
-- PATIENT_COMMUNICATIONS_V1.md seccion 11).
--
-- Alcance deliberadamente chico: solo las 6 prestaciones de la actividad
-- cardiologica actual (consulta, holter, mapa, electrocardiograma, ecg,
-- ecocardiograma doppler). El resto del catalogo real sigue cayendo a
-- '_default' a proposito.
--
-- Estado real verificado en Production antes de escribir esta version:
-- de estas 6 claves, HOY existen unicamente 'holter' y 'mapa' (con su
-- prestacion_label/asunto_email/plantillas propios, ya en uso). 'consulta',
-- 'electrocardiograma', 'ecg' y 'ecocardiograma doppler' NO existen
-- todavia. Los textos de instrucciones_paciente de abajo son los que
-- quedaron efectivamente aprobados y probados en Staging (QA real) -no los
-- de un borrador anterior de este mismo archivo.
--
-- Por eso el INSERT de esta version SOLO especifica tres columnas:
-- prestacion_normalizada, prestacion_label, instrucciones_paciente.
--   - Para 'holter'/'mapa' (ya existen): dispara el ON CONFLICT, que
--     actualiza UNICAMENTE instrucciones_paciente. prestacion_label,
--     asunto_email, las 4 plantillas y activo quedan exactamente como
--     estan hoy en Production - no se leen ni se pisan, aunque
--     prestacion_label figure en la lista de columnas del INSERT (ese
--     valor solo se usaria si la fila no existiera).
--   - Para 'consulta'/'electrocardiograma'/'ecg'/'ecocardiograma doppler'
--     (no existen): entran por el INSERT normal con prestacion_normalizada
--     + prestacion_label + instrucciones_paciente. asunto_email y las 4
--     plantillas NO se especifican -> quedan NULL (el emisor usa el
--     respaldo generico de la fila '_default' para esos campos, via
--     armarMensaje()/elegirPlantilla() en supabase/functions/_shared/
--     comunicaciones-logica.js). activo usa su default (true).
--
-- No se agregan asuntos ni plantillas nuevas para ninguna de las 6 filas.
-- La fila 'eco' (sembrada por la migracion base, para el boton manual de
-- WhatsApp textoWsTurno350('eco')) no aparece en este archivo y no se toca.

begin;

insert into public.cardiolink_prestacion_templates
  (prestacion_normalizada, prestacion_label, instrucciones_paciente)
values
  ('consulta', 'Consulta',
   'Traer DNI y orden/bono o autorización si corresponde.'),

  ('holter', 'Holter',
   'Concurrir con ropa cómoda. Evitar cremas o aceites en el tórax el día del estudio. Traer 1 pila AA, preferentemente Duracell o Energizer. Evitar otras marcas porque pueden agotarse antes de finalizar el registro, invalidar el estudio y obligar a repetirlo.'),

  ('mapa', 'MAPA',
   'Concurrir con ropa cómoda y manga amplia. Traer 2 pilas AA, preferentemente Duracell, Energizer o Philips. Evitar otras marcas porque pueden agotarse antes de finalizar el registro, invalidar el estudio y obligar a repetirlo. Continuar la medicación habitual salvo indicación médica contraria.'),

  ('electrocardiograma', 'Electrocardiograma',
   'Traer DNI y orden/bono o autorización si corresponde. No hace falta ayuno ni preparación especial.'),

  ('ecg', 'ECG',
   'Traer DNI y orden/bono o autorización si corresponde. No hace falta ayuno ni preparación especial.'),

  ('ecocardiograma doppler', 'Ecocardiograma Doppler',
   'Traer DNI, estudios previos si tiene y orden/bono o autorización si corresponde. No requiere ayuno.')

on conflict (prestacion_normalizada) do update set
  instrucciones_paciente = excluded.instrucciones_paciente;
  -- Para 'holter'/'mapa' (ya existen en Production) esto actualiza
  -- UNICAMENTE instrucciones_paciente. prestacion_label/asunto_email/
  -- plantilla_confirmacion/plantilla_recordatorio/plantilla_reprogramacion/
  -- plantilla_cancelacion/activo NO se tocan en el UPDATE.
  -- created_at/updated_at/revision los pone solos el trigger
  -- cardiolink_prestacion_templates_stamp_row (ya existente) - no se tocan
  -- acá.

commit;
