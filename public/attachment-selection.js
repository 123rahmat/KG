/** File identities and a stable snapshot of the selected composer inputs. */
export function selectedAttachments(files, selection) {
  const attached = Array.isArray(files) ? files : [];
  return attached.filter(file => !(selection instanceof Set) || selection.has(file));
}
