/** A workspace terminal's name: its folder, that folder's current branch, and its number from the second tab on. */
export function tabLabel(folderName: string, branch: string | undefined, number: number): string {
  const base = branch ? `${folderName} · ${branch}` : folderName;
  return number > 1 ? `${base} ${number}` : base;
}
