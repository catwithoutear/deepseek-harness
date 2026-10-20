/**
 * Render the Linux hicolor icon set and the tray bitmap.
 *
 * Linux reads application icons from the freedesktop hicolor theme, so a single
 * 1024 px source is not enough: panels look up standard size directories
 * (16, 24, 32, 48, 64, 128, 256, 512). The rounded-square brand PNG already has
 * transparent corners, which is what the theme expects.
 *
 * The committed `resources/linux-icons/` and `resources/tray.png` are the
 * output; rerun `pnpm run render:linux-icons` in `apps/desktop` after changing
 * the source bitmap.
 */

import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'

/** Standard hicolor application icon sizes installed by the deb. */
export const LINUX_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512] as const

/** Tray bitmap edge length; panels scale down to their own slot size. */
export const LINUX_TRAY_SIZE = 32

/** Rounded-square source bitmap (transparent corners) and committed outputs. */
export const LINUX_ICON_PATHS = {
  source: resolve(import.meta.dirname, '../resources/icon-windows.png'),
  directory: resolve(import.meta.dirname, '../resources/linux-icons'),
  tray: resolve(import.meta.dirname, '../resources/tray.png'),
} as const

/** Rasterize one square PNG at the requested edge length. */
async function renderSquare(size: number, destination: string): Promise<void> {
  await sharp(LINUX_ICON_PATHS.source).resize(size, size, { fit: 'contain' }).png().toFile(destination)
}

await mkdir(LINUX_ICON_PATHS.directory, { recursive: true })
for (const size of LINUX_ICON_SIZES) {
  await renderSquare(size, resolve(LINUX_ICON_PATHS.directory, `${size}x${size}.png`))
}
await renderSquare(LINUX_TRAY_SIZE, LINUX_ICON_PATHS.tray)
