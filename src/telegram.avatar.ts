/**
 * Fetches user profile photo via Bot API and returns raw bytes (token stays on server).
 */
export async function fetchTelegramUserAvatar(
  botToken: string,
  userId: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const photosRes = await fetch(
    `https://api.telegram.org/bot${botToken}/getUserProfilePhotos?user_id=${encodeURIComponent(userId)}&limit=1`,
  )
  const photosJson = (await photosRes.json()) as {
    ok?: boolean
    result?: { photos?: Array<Array<{ file_id: string }>> }
  }
  if (!photosJson.ok || !photosJson.result?.photos?.length) return null

  const sizes = photosJson.result.photos[0]
  const best = sizes[sizes.length - 1]
  if (!best?.file_id) return null

  const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${best.file_id}`)
  const fileJson = (await fileRes.json()) as { ok?: boolean; result?: { file_path?: string } }
  if (!fileJson.ok || !fileJson.result?.file_path) return null

  const path = fileJson.result.file_path
  const imgRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${path}`)
  if (!imgRes.ok) return null

  const buffer = Buffer.from(await imgRes.arrayBuffer())
  const ext = path.split('.').pop()?.toLowerCase()
  const contentType =
    ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg'

  return { buffer, contentType }
}
