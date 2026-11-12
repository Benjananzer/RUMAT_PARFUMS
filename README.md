# Rumat Parfums: tienda con Vercel + Neon

Catálogo, carrito, pedido por WhatsApp y administrador con contraseña.
Los perfumes, fotos y videos se guardan en la base de datos de Neon.

## Cómo publicarla (unos 15 minutos)

1. **Neon (base de datos):** creá una cuenta en neon.com, hacé "New Project" y copiá la
   **Connection string** (empieza con `postgresql://`). Las tablas se crean solas.
2. **GitHub:** creá un repositorio nuevo y subí esta carpeta completa.
3. **Vercel (hosting):** en vercel.com elegí "Add New > Project" e importá el repositorio.
   - Framework Preset: **Other**.
   - En "Environment Variables" cargá:
     - `DATABASE_URL`: la connection string de Neon.
     - `ADMIN_PASSWORD`: la contraseña del administrador (la que elijan).
     - `SESSION_SECRET`: un texto largo y al azar (para firmar las sesiones).
4. Tocá **Deploy**. Cuando termine, abrí la dirección que te da Vercel.
5. Para entrar al administrador, tocá "Admin" al final de la página (o agregá `#admin` a la dirección).
6. **Dominio propio:** en Vercel, Settings > Domains.

## Cosas a saber

- Cambiar la contraseña: cambiá `ADMIN_PASSWORD` en Vercel y hacé "Redeploy".
- Las fotos se achican solas. Los videos pueden pesar hasta 4 MB (límite de Vercel).
- Cualquier cambio en el administrador se ve al instante para todos los visitantes.
- El stock no baja solo con cada pedido: se actualiza desde el administrador.
- Los pagos se coordinan por WhatsApp (transferencia o efectivo al retirar en el local).
- El número de WhatsApp está en `public/index.html` (variable `WA`).

## Archivos

- `public/index.html`: la tienda (lo que ven los clientes y el administrador).
- `api/index.js`: el servidor (login, catálogo, fotos y videos).
- `vercel.json`, `package.json`: configuración.
