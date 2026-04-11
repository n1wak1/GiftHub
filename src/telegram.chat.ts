/** Bot API: https://core.telegram.org/bots/api#getchat */
export async function fetchTelegramChatInfo(
  botToken: string,
  chatId: string,
): Promise<{ firstName?: string; lastName?: string; username?: string } | null> {
  const r = await fetch(`https://api.telegram.org/bot${botToken}/getChat?chat_id=${encodeURIComponent(chatId)}`)
  const j = (await r.json()) as {
    ok?: boolean
    result?: { first_name?: string; last_name?: string; username?: string }
  }
  if (!j.ok || !j.result) return null
  const c = j.result
  return {
    firstName: c.first_name,
    lastName: c.last_name,
    username: c.username,
  }
}
