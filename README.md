# MAHRA · Backend de seguimiento de pedidos de pre-venta

Servicio que la landing usa para consultar el estado de un pedido. Une dos
fuentes y guarda el token de Tienda Nube fuera de la página pública.

```
ONLINE:  landing --(número + DNI)--> backend --> Tienda Nube API
LOCAL:   landing --(solo DNI)------> backend --> local.json
                                                   ^
                              n8n lee la Google Sheet CAMPEONES (carga manual)
                              y la empuja al backend (POST /api/local)
```

## Endpoints

- `GET /api/pedido?num=...&contacto=...`
  - con `num` → busca la compra ONLINE en Tienda Nube y verifica el DNI/email.
  - sin `num` → busca la compra de LOCAL por DNI en local.json.
- `POST /api/local` (lo usa n8n) → reemplaza local.json con el lote de ventas
  de la hoja. Requiere header `x-mahra-key`.
- `GET /health` → chequeo.

## Instalación

```bash
npm install
cp .env.example .env     # completá tus datos
npm start
```

## Variables (.env)

- `TN_STORE_ID`, `TN_TOKEN`, `TN_USER_AGENT`: para leer pedidos online (scope read_orders).
- `ORIGEN`: dominio de tu web (CORS).
- `LOCAL_SYNC_KEY`: clave secreta compartida con n8n. El mismo valor va en el
  workflow (nodo "Enviar al backend", header `x-mahra-key`).

## La Google Sheet de CAMPEONES (carga manual)

Creá una hoja nueva con estos encabezados en la fila 1:

| dni | nombre | telefono | mail | color | talle | cantidad | fecha_compra | despachado | entregado |
|-----|--------|----------|-------|-------|-------|----------|--------------|------------|-----------|

- `dni`: con esto consulta la clienta (clave).
- `color`: azul / chocolate / suela (el flujo también entiende los códigos AZ, CHTE, SLA).
- `fecha_compra`: 2026-05-20 (o dd/mm/aaaa, el flujo lo convierte).
- `despachado` / `entregado`: dejalas vacías y poné TRUE (o "si"/"x"/"1")
  cuando esté listo para retiro / entregado. La hoja manda: lo que pongas
  ahí es lo que ve la clienta.

## El workflow de n8n

Ya está creado en tu n8n (inactivo): **"MAHRA · Sync Ventas Local CAMPEONES"**.
Para activarlo:

1. Nodo "Leer Hoja CAMPEONES": pegá el ID de tu Google Sheet y confirmá la
   credencial de Google (ya quedó asignada la de tus flujos) y el nombre de la
   pestaña.
2. Nodo "Mapear a formato backend": si tus encabezados no son los de arriba,
   ajustá el objeto COL (una línea por columna).
3. Nodo "Enviar al backend": poné la URL real del backend y la `x-mahra-key`
   (el mismo valor que LOCAL_SYNC_KEY del .env).
4. Probalo con "Ejecutar a mano" y, si anda, activá el workflow (corre cada 6 h).

## Publicar

Cualquier hosting con Node (Railway, Render, Fly, VPS). Cargá las variables del
.env en el panel del hosting (no subas el .env), apuntá tu dominio
(ej. api.mahra.com.ar) y en la landing poné USAR_BACKEND = true y la BACKEND_URL.

## Traducción de estados de Tienda Nube (ventas online)

| shipping_status                         | despachado | entregado |
| --------------------------------------- | :--------: | :-------: |
| unpacked / unfulfilled                  |     no     |    no     |
| shipped / fulfilled / partially_fulfilled |   sí     |    no     |
| delivered                               |     sí     |    sí     |
| status: closed                          |     —      |    sí     |
