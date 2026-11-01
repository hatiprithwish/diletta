// DEV_NOTE: Prompt fences around untrusted text: a text can't close its fence early, since any of the fence's tags inside
// it is defused. Returns the defuse function for those tags.
export function fenceDefuser(tags: string[]): (text: string) => string {
  const fenceTag = new RegExp(`<(\\s*\\/?\\s*(?:${tags.join("|")})\\b)`, "gi");
  return (text) => text.replace(fenceTag, "&lt;$1");
}
