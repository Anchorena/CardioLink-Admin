-- CardioLink Admin - Comunicaciones V1.2, Bloque A
-- Actualiza el texto de instrucciones_paciente de las filas 'holter' y
-- 'mapa' ya existentes en cardiolink_prestacion_templates, agregando la
-- indicacion de pilas AA pedida explicitamente por el consultorio.
--
-- REDACTADA, NO EJECUTADA TODAVIA. Sin CREATE/ALTER: sólo 2 UPDATE sobre
-- filas que ya existen (sembradas por
-- 20260828120000_cardiolink_communications_schema.sql). No crea ninguna
-- tabla, columna ni policy nueva. No toca ninguna otra fila (_default,
-- eco, consulta, ni las de cardiología agregadas por
-- 20260905090000_cardiolink_prestacion_templates_cardiologia.sql).
--
-- El trigger cardiolink_prestacion_templates_90_stamp (ya existente) se
-- encarga solo de actualizar updated_at/revision - no hace falta tocarlo.

begin;

update public.cardiolink_prestacion_templates
   set instrucciones_paciente =
     'Traer DNI, orden/bono o autorización si corresponde. '
     || 'El equipo requiere 1 pila AA, preferentemente Duracell o Energizer. '
     || 'Otras marcas pueden agotarse antes de finalizar el estudio y '
     || 'comprometer o inutilizar el registro.'
 where prestacion_normalizada = 'holter';

update public.cardiolink_prestacion_templates
   set instrucciones_paciente =
     'Traer DNI, orden/bono o autorización si corresponde. '
     || 'Venir con ropa cómoda para la colocación del equipo. '
     || 'El estudio requiere 2 pilas AA, preferentemente Duracell, Energizer '
     || 'o Philips. Otras marcas pueden agotarse antes de finalizar el '
     || 'estudio y comprometer o inutilizar el registro.'
 where prestacion_normalizada = 'mapa';

commit;
