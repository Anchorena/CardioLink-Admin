#!/usr/bin/env python3
"""CardioLink · Pendientes de cobro V1 — prueba de CONCURRENCIA REAL del guard v4.2.1 (dos sesiones) sobre la tabla real cardiolink_atenciones.
SOLO STAGING (ref fijo). Requiere la CLI de Supabase autenticada. Usa filas sintéticas con prefijo qa_conc_ y las borra al final.
Las sesiones actúan como el médico de prueba con SET LOCAL ROLE authenticated + claims (mismo mecanismo que la suite SQL): ejecutan la RLS y los
triggers reales. No usa service_role. Uso: python3 pending_review_cobros_v1_guard_v421_concurrencia.py
Escenarios:
  C1  resurrección: T2 (admin/postgres) borra una fila confirmada y retiene la transacción; T1 (médico) hace upsert con marcas de confirmación.
      Esperado: T1 espera, luego es RECHAZADA (42501) y la fila NO reaparece.
  C2  upsert legítimo concurrente sobre una fila existente: T2 (médico) edita y retiene; T1 (médico) hace upsert sin cambios financieros.
      Esperado: ambas terminan OK (sin deadlock ni error inesperado).
  C3  borrado concurrente + alta legítima ('cobrada al registrar', sin marcas): T1 se inserta como alta nueva y tiene éxito.
"""
import json, re, subprocess, sys, threading, time
REF = 'yslhwdlzdknhskawqrtv'          # STAGING. Production (tupacclmhaqiahhlttyz) está PROHIBIDO.
assert REF == 'yslhwdlzdknhskawqrtv'
CLI = '/opt/homebrew/bin/supabase'

def q(sql):
    r = subprocess.run([CLI, 'db', 'query', '--linked', '--project-ref', REF, '-o', 'json', sql], capture_output=True, text=True)
    out = r.stdout; m = re.search(r'\{.*\}', out, re.S)
    err = (r.stderr or '') + out
    e = re.search(r'ERROR:\s*([0-9A-Z]{5}):\s*([^"\\]{0,200})', err)
    rows = json.loads(m.group(0)).get('rows', []) if m else []
    return rows, (e.group(1) + ' ' + e.group(2).strip() if e else None)

PREFIJO = 'qa_conc_'
def sembrar(id_, extra=''):
    q(f"""INSERT INTO public.cardiolink_atenciones (id, payload, updated_at)
          SELECT '{id_}', jsonb_build_object('id','{id_}','paciente','QA CONCURRENCIA','profesionalId',r.professional_id,'cajaPerfil',r.professional_id,
            'fecha',current_date::text,'estadoTurno','reservado','tipoCobro','Particular','formaPago','Efectivo','montoConsulta',35000,
            'estadoCobro','cobrado','cobroPendienteEn',now()::text,'cobroConfirmadoEn',now()::text,'cobroConfirmadoPor','qa@cardiolink-qa.test',
            'cobroConfirmadoPorId','00000000-0000-0000-0000-000000000000','cobroConfirmadoPorRol','secretaria','cobroConfirmadoPorEmail','qa@cardiolink-qa.test',
            'cobroMedioPago','Efectivo','cobroAuditoria','[{{"accion":"pendiente"}},{{"accion":"confirmado"}}]'::jsonb) {extra}, now()
          FROM public.cardiolink_user_roles r WHERE r.base_role='medico' AND r.active LIMIT 1 ON CONFLICT (id) DO NOTHING""")

def como_medico(cuerpo):
    return f"""BEGIN;
DO $$
DECLARE v_med uuid; v_prof text;
BEGIN
  SELECT user_id, professional_id INTO v_med, v_prof FROM public.cardiolink_user_roles WHERE base_role='medico' AND active LIMIT 1;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_med, 'role', 'authenticated', 'email', (SELECT email FROM auth.users WHERE id = v_med))::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_med::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  {cuerpo}
  EXECUTE 'RESET ROLE';
END $$;
COMMIT;"""

def payload_forjado(id_, ok=False):
    base = "jsonb_build_object('id','%s','paciente','QA CONCURRENCIA FORJADA','profesionalId',v_prof,'cajaPerfil',v_prof,'fecha',current_date::text,'estadoTurno','reservado','tipoCobro','Particular','formaPago','Efectivo','montoConsulta',35000,'estadoCobro','cobrado','cobroConfirmadoEn',now()::text,'cobroMedioPago','Efectivo'" % id_
    if ok:   # alta legítima 'cobrada al registrar'
        return base + ",'cobroConfirmadoPor','Dra QA','cobroAuditoria','[{\"accion\":\"cobrado_al_registrar\"}]'::jsonb)"
    return base + ",'cobroPendienteEn',now()::text,'cobroConfirmadoPor','FORJADA','cobroConfirmadoPorId','00000000-0000-0000-0000-000000000000','cobroConfirmadoPorRol','secretaria','cobroConfirmadoPorEmail','forjada@falso.test','cobroAuditoria','[{\"accion\":\"pendiente\"},{\"accion\":\"confirmado\"}]'::jsonb)"

def upsert(id_, ok=False):
    return f"INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES ('{id_}', {payload_forjado(id_, ok)}, now()) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at;"

def dos_sesiones(sql_t2, sql_t1, retraso=4):
    res = {}
    def t2(): res['t2'] = q(sql_t2); res['t2_fin'] = time.time()
    th = threading.Thread(target=t2); t0 = time.time(); th.start(); time.sleep(retraso)
    t1_ini = time.time(); res['t1'] = q(sql_t1); res['t1_fin'] = time.time(); th.join()
    res['t1_espera'] = round(res['t1_fin'] - t1_ini, 1); res['t1_tras_t2'] = res['t1_fin'] >= res['t2_fin'] - 0.5
    return res

resultados = []
def reg(caso, esperado, obtenido, ok): resultados.append((caso, esperado, obtenido, 'PASS' if ok else 'FAIL')); print(('PASS' if ok else 'FAIL'), caso, '|', obtenido)

def existe(id_): return q(f"select count(*) n from public.cardiolink_atenciones where id='{id_}'")[0][0]['n'] if q(f"select 1")[0] is not None else None

def main():
    q(f"delete from public.cardiolink_atenciones where id like '{PREFIJO}%'")
    # C1 resurrección
    sembrar(PREFIJO + 'c1')
    r = dos_sesiones(f"BEGIN; DELETE FROM public.cardiolink_atenciones WHERE id='{PREFIJO}c1'; SELECT pg_sleep(10); COMMIT;", como_medico(upsert(PREFIJO + 'c1')))
    n = q(f"select count(*) n from public.cardiolink_atenciones where id='{PREFIJO}c1'")[0][0]['n']
    reg('C1 el upsert con marcas NO resucita una confirmación eliminada concurrentemente', 'T1 espera y recibe 42501; la fila no reaparece',
        f"T1 espera {r['t1_espera']}s tras T2={r['t1_tras_t2']}, T1 error={r['t1'][1]}, filas={n}", r['t1_tras_t2'] and (r['t1'][1] or '').startswith('42501') and n == 0)
    # C2 upsert legítimo concurrente
    sembrar(PREFIJO + 'c2')
    cuerpo_t2 = f"UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload,'{{observaciones}}','\"t2\"') WHERE id='{PREFIJO}c2'; PERFORM pg_sleep(8);"
    cuerpo_t1 = f"INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) SELECT id, payload, now() FROM public.cardiolink_atenciones WHERE id='{PREFIJO}c2' ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload || '{{\"observaciones\":\"t1\"}}'::jsonb, updated_at = EXCLUDED.updated_at;"
    r = dos_sesiones(como_medico(cuerpo_t2), como_medico(cuerpo_t1))
    obs = q(f"select payload->>'observaciones' o from public.cardiolink_atenciones where id='{PREFIJO}c2'")[0]
    reg('C2 dos upserts/ediciones legítimos concurrentes del médico sobre una fila confirmada: sin deadlock ni error', 'ambas OK (T1 espera a T2)',
        f"T2 error={r['t2'][1]}, T1 error={r['t1'][1]}, espera T1={r['t1_espera']}s, observaciones final={obs[0]['o'] if obs else None}", r['t2'][1] is None and r['t1'][1] is None)
    # C3 alta legítima con borrado concurrente de otra fila y misma clave libre
    sembrar(PREFIJO + 'c3')
    r = dos_sesiones(f"BEGIN; DELETE FROM public.cardiolink_atenciones WHERE id='{PREFIJO}c3'; SELECT pg_sleep(8); COMMIT;", como_medico(upsert(PREFIJO + 'c3', ok=True)))
    n = q(f"select count(*) n from public.cardiolink_atenciones where id='{PREFIJO}c3'")[0][0]['n']
    reg('C3 tras un borrado concurrente, el alta legítima "cobrada al registrar" (sin marcas) se acepta', 'T1 OK y la fila queda como alta nueva',
        f"T1 error={r['t1'][1]}, filas={n}", r['t1'][1] is None and n == 1)
    q(f"delete from public.cardiolink_atenciones where id like '{PREFIJO}%'")
    resid = q(f"select count(*) n from public.cardiolink_atenciones where id like '{PREFIJO}%'")[0][0]['n']
    reg('Limpieza de filas sintéticas qa_conc_', '0', str(resid), resid == 0)
    print(json.dumps([dict(zip(('caso', 'esperado', 'obtenido', 'estado'), x)) for x in resultados], ensure_ascii=False, indent=1))
    sys.exit(0 if all(x[3] == 'PASS' for x in resultados) else 1)

if __name__ == '__main__': main()
