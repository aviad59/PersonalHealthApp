/** Save a freshly-captured photo to the device (Downloads) so the user
 *  keeps a full-quality copy — a camera capture via <input> isn't added
 *  to the gallery by the browser, so we offer the file for download. */
export function saveToDevice(f: File) {
  try {
    const url = URL.createObjectURL(f);
    const a = document.createElement("a");
    a.href = url;
    const ext = (f.type.split("/")[1] || "jpg").replace("jpeg", "jpg");
    a.download = `meal-${Date.now()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch {
    // best-effort — never block logging on the save
  }
}
