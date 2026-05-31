/* =============================================================================
   MAHRA · Backend de consulta de pedidos de pre-venta
   -----------------------------------------------------------------------------
   Qué hace:
     - Expone UN endpoint público:  GET /api/pedidos/:num?contacto=...
     - Busca el pedido en Tienda Nube con tu token (que vive solo acá, nunca
       en la página pública).
     - Para ventas de LOCAL (que no están en Tienda Nube) busca en un archivo
       local.json que vos mantenés (export del facturador o carga a mano).
     - Devuelve SIEMPRE el mismo JSON que la landing sabe leer:
         { num, cliente, canal, modelo, color, talle, cantidad,
           fechaCompra, despachado, entregado }

   Mapeo de estados de Tienda Nube -> camino de la landing:
     - despachado = shipping_status es "shipped" / "fulfilled" / "delivered"
                    (o sea: ya salió del taller, está en camino o entregado)
     - entregado  = shipping_status es "delivered"  Ó  status es "closed"
                    (pedido entregado / cerrado)
   ============================================================================= */

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();

/* ------------------------------------------------------------------ CONFIG */
const PORT        = process.env.PORT        || 3000;
const TN_STORE_ID = process.env.TN_STORE_ID;            // ej: 475098
const TN_TOKEN    = process.env.TN_TOKEN;               // access_token de tu app
const TN_UA       = process.env.TN_USER_AGENT || 'MAHRA Seguimiento (hola@mahra.com.ar)';
const TN_API      = `https://api.tiendanube.com/2025-03/${TN_STORE_ID}`;

/* Clave compartida con n8n para que SOLO tu flujo pueda actualizar las
   ventas de local. Poné un valor largo y secreto en .env (LOCAL_SYNC_KEY). */
const LOCAL_SYNC_KEY = process.env.LOCAL_SYNC_KEY || '';

app.use(express.json({ limit: '2mb' }));   // para leer el body JSON de n8n

/* Solo permitimos que tu propia web llame a este backend (CORS).
   Cambiá el origin por tu dominio real cuando publiques.                     */
const ORIGEN_PERMITIDO = process.env.ORIGEN || 'https://mahra.com.ar';
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ORIGEN_PERMITIDO);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-mahra-key');
  next();
});

/* Nombre del modelo de pre-venta que queremos mostrar lindo en la landing.
   Si el pedido contiene este producto, usamos este nombre.                   */
const MODELO_PREVENTA = 'Campeones del Quilombo';

/* ============================================================== TIENDA NUBE */

async function tnGet(ruta) {
  const r = await fetch(`${TN_API}${ruta}`, {
    headers: {
      'Authentication': `bearer ${TN_TOKEN}`,
      'User-Agent': TN_UA,
      'Content-Type': 'application/json'
    }
  });
  if (!r.ok) throw new Error(`Tienda Nube ${r.status}`);
  return r.json();
}

/* Detecta color/talle desde las variantes del producto (variant_values).
   En Tienda Nube las variantes vienen como ["Azul","40"] o similar.          */
function leerVariantes(prod) {
  const vals = (prod.variant_values || []).map(v => String(v).trim());
  /* nombres y códigos posibles -> nombre interno (azul/chocolate/suela) */
  const coloresConocidos = {
    azul:'azul', az:'azul',
    chocolate:'chocolate', chte:'chocolate', marron:'chocolate', 'marrón':'chocolate',
    suela:'suela', sla:'suela', camel:'suela', beige:'suela'
  };
  let color = '', talle = '';
  for (const v of vals) {
    const low = v.toLowerCase();
    if (coloresConocidos[low]) color = coloresConocidos[low];
    else if (/^\d{2}(\.\d)?$/.test(v)) talle = v;          // 36, 37, 40...
  }
  return { color, talle };
}

/* Traduce un pedido de Tienda Nube al formato unificado de la landing.       */
function mapearPedidoTN(o) {
  /* tomamos el primer producto que matchee el modelo de pre-venta;
     si no hay match, tomamos el primero del pedido.                          */
  const prod = (o.products || []).find(p =>
                 (p.name || '').toLowerCase().includes('quilombo'))
             || (o.products || [])[0] || {};
  const { color, talle } = leerVariantes(prod);

  const ship = (o.shipping_status || '').toLowerCase();
  const despachado = ['shipped', 'fulfilled', 'partially_fulfilled', 'delivered'].includes(ship);
  const entregado  = ship === 'delivered' || (o.status || '').toLowerCase() === 'closed';

  return {
    num:        String(o.number),
    cliente:    o.contact_name || o.customer?.name || 'Cliente',
    canal:      'online',
    modelo:     MODELO_PREVENTA,
    color:      color || 'suela',
    talle:      talle || (prod.variant_values?.[0] ?? ''),
    cantidad:   Number(prod.quantity || 1),
    fechaCompra: (o.created_at || '').slice(0, 10),       // YYYY-MM-DD
    despachado,
    entregado
  };
}

/* Verifica que el contacto (email o DNI) coincida con el pedido, para que
   nadie pueda ver el pedido de otra persona sabiendo solo el número.         */
function contactoCoincide(o, contacto) {
  const c = contacto.trim().toLowerCase();
  const email = (o.contact_email || '').toLowerCase();
  const dni   = (o.contact_identification || '').toLowerCase();
  return c === email || c === dni;
}

/* ===================================================================== LOCAL */
/* Ventas del local físico. Tienda Nube no las tiene; las alimenta n8n desde
   la Google Sheet de ventas diarias (ver endpoint POST /api/local).
   En el local NO hay número de pedido: la clienta se identifica con su DNI,
   que es la clave de búsqueda. Formato de cada registro:
     { "cliente":"...", "contacto":"DNI", "color":"azul", "talle":"39",
       "cantidad":1, "fechaCompra":"2026-05-20",
       "despachado":false, "entregado":false }                                */
function buscarLocalPorDni(dni) {
  const archivo = path.join(__dirname, 'local.json');
  if (!fs.existsSync(archivo)) return null;
  let lista;
  try { lista = JSON.parse(fs.readFileSync(archivo, 'utf8')); }
  catch { return null; }

  const d = dni.trim().toLowerCase();
  /* puede haber más de una compra con el mismo DNI: tomamos la más reciente */
  const coincidencias = lista
    .filter(x => String(x.contacto || '').trim().toLowerCase() === d)
    .sort((a, b) => String(b.fechaCompra).localeCompare(String(a.fechaCompra)));
  const p = coincidencias[0];
  if (!p) return null;

  return {
    num: 'Compra en local', cliente: p.cliente || 'Cliente', canal: 'local',
    modelo: MODELO_PREVENTA, color: p.color || 'suela', talle: p.talle || '',
    cantidad: Number(p.cantidad || 1), fechaCompra: p.fechaCompra,
    despachado: p.despachado === true, entregado: p.entregado === true
  };
}

/* =================================================================== ENDPOINT
   GET /api/pedido?num=...&contacto=...
     - con `num`  -> compra ONLINE: busca en Tienda Nube y verifica el contacto.
     - sin `num`  -> compra en LOCAL: busca en la hoja por DNI (= contacto).      */

app.get('/api/pedido', async (req, res) => {
  const num = (req.query.num || '').trim();
  const contacto = (req.query.contacto || '').trim();

  if (!contacto) {
    return res.status(400).json({ error: 'Falta el DNI / contacto' });
  }

  try {
    /* --- LOCAL: sin número de pedido, búsqueda por DNI --- */
    if (!num) {
      const local = buscarLocalPorDni(contacto);
      if (local) return res.json(local);
      return res.status(404).json({ error: 'No encontrado' });
    }

    /* --- ONLINE: con número, búsqueda en Tienda Nube. q busca por número. --- */
    const limpio = num.replace(/[^\d]/g, '');             // "MH-1042" -> "1042"
    const lista = await tnGet(`/orders?q=${encodeURIComponent(limpio)}&per_page=50`);

    const o = (lista || []).find(x => String(x.number) === limpio);
    if (!o)                       return res.status(404).json({ error: 'No encontrado' });
    if (!contactoCoincide(o, contacto)) return res.status(404).json({ error: 'No encontrado' });

    return res.json(mapearPedidoTN(o));
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: 'No se pudo consultar el pedido' });
  }
});

/* ============================================ SINCRONIZACIÓN VENTAS DE LOCAL
   n8n llama a este endpoint con el lote de ventas de pre-venta del local
   (parseadas del export del facturador). Reemplaza local.json, pero CONSERVA
   los estados despachado/entregado que ya tenías marcados a mano, así una
   sincronización no pisa el "listo para retiro" que vos cargaste.

   POST /api/local
   Header:  x-mahra-key: <LOCAL_SYNC_KEY>
   Body:    [ { num, cliente, contacto, color, talle, cantidad, fechaCompra,
                despachado?, entregado? }, ... ]
/* ============================================ SINCRONIZACIÓN VENTAS DE LOCAL
   n8n lee la Google Sheet de CAMPEONES (que cargás a mano) y manda acá el
   lote completo de ventas. La hoja es la ÚNICA fuente de verdad: este endpoint
   reemplaza local.json con lo que llega, tal cual. Si corregís algo en la hoja
   (incluido despachado/entregado), en la próxima sincronización se refleja.

   POST /api/local
   Header:  x-mahra-key: <LOCAL_SYNC_KEY>
   Body:    [ { cliente, contacto(DNI), color, talle, cantidad, fechaCompra,
                despachado, entregado }, ... ]
*/
app.post('/api/local', (req, res) => {
  if (!LOCAL_SYNC_KEY || req.get('x-mahra-key') !== LOCAL_SYNC_KEY) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  const entrantes = req.body;
  if (!Array.isArray(entrantes)) {
    return res.status(400).json({ error: 'Se esperaba un array de ventas' });
  }

  /* normalizamos cada fila; la hoja manda, incluido el estado de retiro */
  const salida = entrantes
    .filter(e => String(e.contacto || '').trim() !== '')   // sin DNI no sirve
    .map(e => ({
      cliente: e.cliente || 'Cliente',
      contacto: String(e.contacto).trim(),
      color: String(e.color || 'suela').toLowerCase(),
      talle: String(e.talle || ''),
      cantidad: Number(e.cantidad || 1),
      fechaCompra: e.fechaCompra,
      despachado: e.despachado === true,
      entregado: e.entregado === true
    }));

  const archivo = path.join(__dirname, 'local.json');
  try {
    fs.writeFileSync(archivo, JSON.stringify(salida, null, 2), 'utf8');
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'No se pudo guardar' });
  }
  res.json({ ok: true, total: salida.length });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`MAHRA backend escuchando en :${PORT}`));
