import { invoke } from "@tauri-apps/api/core";

/** Octets bruts d'un fichier (réponse `ipc::Response`, hors JSON). */
export function readBytes(path: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("read_bytes", { path });
}

/** Plage d'octets d'un fichier (`len` plafonné à 1 Mio côté Rust). */
export function readRange(path: string, offset: number, len: number): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("read_range", { path, offset, len });
}
