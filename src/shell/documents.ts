import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { DialogFilter } from "@tauri-apps/plugin-dialog";
import i18n from "../i18n";
import { commands } from "../ipc/bindings";
import type {
  Capabilities,
  Detected,
  DocumentModel,
  HandlerInfo,
  OpenedDocument,
} from "../ipc/bindings";
import { useRecent } from "../stores/recent";
import { useSettings } from "../stores/settings";
import { tabRevision, useTabs } from "../stores/tabs";
import type { TabEntry } from "../stores/tabs";
import { useUi } from "../stores/ui";
import { reportError } from "./errors";
import { getHandlers } from "./handlers";
import { NEW_DOCUMENTS } from "./newDocuments";
import { basename, extOf } from "./paths";
import { SaveCancelled, clearTabRuntime, getSaveHandler, getSerializer } from "./runtime";
import { choose, confirm } from "./ui/dialogStore";
import { pushToast } from "./ui/toastStore";

const t = (key: string, opts?: Record<string, unknown>): string => i18n.t(key, opts);

function getTab(id: string): TabEntry | undefined {
  return useTabs.getState().tabs.find((tab) => tab.id === id);
}

function label(h: HandlerInfo): string {
  return t(h.labelKey, { defaultValue: h.id });
}

function silently(p: Promise<unknown>): void {
  p.catch(() => undefined);
}

/** Génération par document : invalide les autosaves en vol quand l'entrée de récupération est supprimée. */
const recoveryGen = new Map<string, number>();

function gen(docId: string): number {
  return recoveryGen.get(docId) ?? 0;
}

/** Supprime l'entrée de récupération et invalide les autosaves en cours pour ce document. */
export function discardRecovery(docId: string): void {
  recoveryGen.set(docId, gen(docId) + 1);
  silently(commands.recoveryDiscard(docId));
}

function fromOpened(doc: OpenedDocument) {
  return {
    path: doc.path,
    title: basename(doc.path),
    handlerId: doc.handlerId,
    modelKind: doc.model.kind,
    readOnly: !doc.capabilities.write,
    detected: doc.detected,
    capabilities: doc.capabilities,
    docId: doc.docId,
    model: doc.model,
    warnings: doc.warnings,
  };
}

function showWarnings(warnings: string[]): void {
  for (const w of warnings) pushToast({ kind: "info", text: t(w, { defaultValue: w }) });
}

const opening = new Map<string, Promise<unknown>>();

/** Ouvre le fichier ; renvoie l'erreur éventuelle (`null` = succès). */
async function tryOpen(path: string, forcedHandler: string | null): Promise<unknown> {
  const existing = useTabs.getState().tabs.find((tab) => tab.path === path);
  if (existing && forcedHandler === null) {
    useTabs.getState().activateTab(existing.id);
    return null;
  }
  try {
    const doc = await commands.openDocument(path, forcedHandler);
    const current = useTabs.getState().tabs.find((tab) => tab.path === path);
    if (current) {
      clearTabRuntime(current.id);
      useTabs.getState().reloadTab(current.id, { ...fromOpened(doc), dirty: false });
      useTabs.getState().activateTab(current.id);
    } else {
      useTabs.getState().openTab(fromOpened(doc));
    }
    silently(commands.watchFile(doc.path));
    useRecent.getState().add(doc.path);
    showWarnings(doc.warnings);
    return null;
  } catch (e) {
    return e;
  }
}

/** Dédoublonne les ouvertures concurrentes d'un même chemin. */
function openOnce(path: string, forcedHandler: string | null): Promise<unknown> {
  const inflight = opening.get(path);
  if (inflight) {
    return forcedHandler === null ? inflight : inflight.then(() => openOnce(path, forcedHandler));
  }
  const p: Promise<unknown> = tryOpen(path, forcedHandler).finally(() => {
    if (opening.get(path) === p) opening.delete(path);
  });
  opening.set(path, p);
  return p;
}

/** Ouvre un fichier dans un onglet (ou active l'onglet existant). */
export async function openPath(path: string, forcedHandler: string | null = null): Promise<void> {
  const err = await openOnce(path, forcedHandler);
  if (err !== null) reportError(err);
}

/** Ouvre un fichier récent ; s'il est introuvable, le retire de la liste. */
export async function openRecent(path: string): Promise<void> {
  const err = await openOnce(path, null);
  if (err === null) return;
  reportError(err);
  if ((err as { code?: unknown } | null)?.code === "notFound") {
    useRecent.getState().remove(path);
    pushToast({ kind: "info", text: t("welcome.recentRemoved", { name: basename(path) }) });
  }
}

export async function openPaths(paths: string[]): Promise<void> {
  for (const p of paths) await openPath(p);
}

export async function openWithDialog(): Promise<void> {
  try {
    const selected = await openDialog({ multiple: true });
    if (selected === null) return;
    await openPaths(Array.isArray(selected) ? selected : [selected]);
  } catch (e) {
    reportError(e);
  }
}

/** Nouveau document vide (sans chemin). */
export function newDocument(kindId: string): void {
  const kind = NEW_DOCUMENTS.find((k) => k.id === kindId);
  if (!kind) return;
  const n = useTabs.getState().nextUntitled();
  useTabs.getState().openTab({
    path: null,
    title: t("newDoc.untitled", { n }),
    handlerId: kind.handlerId,
    modelKind: kind.modelKind,
    readOnly: false,
    docId: crypto.randomUUID(),
    model: kind.build(t("newDoc.sheetName")),
  });
}

/** Rouvre l'onglet depuis le disque, avec un handler forcé (ou le sien si `null`). */
export async function reopenTab(tabId: string, handlerId: string | null): Promise<void> {
  const tab = getTab(tabId);
  if (!tab?.path) return;
  if (tab.dirty) {
    const ok = await confirm({
      title: t("reopen.title"),
      message: t("reopen.message", { name: tab.title }),
      confirmLabel: t("reopen.confirm"),
      danger: true,
    });
    if (!ok) return;
  }
  try {
    const doc = await commands.openDocument(tab.path, handlerId ?? tab.handlerId);
    clearTabRuntime(tabId);
    discardRecovery(tab.docId);
    useTabs
      .getState()
      .reloadTab(tabId, { ...fromOpened(doc), dirty: false, fidelityConfirmed: false });
    showWarnings(doc.warnings);
  } catch (e) {
    reportError(e);
  }
}

/** « Ouvrir comme… » */
export function reopenTabAs(tabId: string, handlerId: string): Promise<void> {
  return reopenTab(tabId, handlerId);
}

/** Recharge après modification externe (confirmation si l'onglet a des modifications non enregistrées). */
export async function reloadFromDisk(tabId: string, confirmed = false): Promise<void> {
  const tab = getTab(tabId);
  if (!tab?.path) return;
  if (tab.dirty && !confirmed) {
    const ok = await confirm({
      title: t("reopen.title"),
      message: t("reopen.message", { name: tab.title }),
      confirmLabel: t("reopen.confirm"),
      danger: true,
    });
    if (!ok) return;
  }
  try {
    const doc = await commands.openDocument(tab.path, tab.handlerId);
    clearTabRuntime(tabId);
    discardRecovery(tab.docId);
    useTabs.getState().reloadTab(tabId, { ...fromOpened(doc), dirty: false });
  } catch (e) {
    reportError(e);
  }
}

export function ignoreExternalChange(tabId: string): void {
  useTabs.getState().patchTab(tabId, { externalChange: false });
}

/** Modèle courant : sérialiseur de l'éditeur, sinon modèle d'ouverture. */
export async function currentModel(tab: TabEntry, forSave = false): Promise<DocumentModel> {
  const serialize = getSerializer(tab.id);
  if (!serialize) return tab.model;
  const m = (await serialize({ forSave })) as object;
  return { ...m, kind: tab.modelKind } as DocumentModel;
}

function writable(handlers: HandlerInfo[], tab: TabEntry): HandlerInfo[] {
  return handlers.filter((h) => h.model === tab.modelKind && h.capabilities.write);
}

function filtersFor(handlers: HandlerInfo[]): DialogFilter[] {
  return handlers
    .filter((h) => h.extensions.length > 0)
    .map((h) => ({ name: label(h), extensions: h.extensions }));
}

function pickHandler(
  handlers: HandlerInfo[],
  path: string,
  preferred: string,
): HandlerInfo | undefined {
  const ext = extOf(path);
  return (
    handlers.find((h) => h.extensions.includes(ext)) ??
    handlers.find((h) => h.id === preferred) ??
    handlers[0]
  );
}

/** Enregistrer sous… ; renvoie `true` si le fichier a été écrit. */
export async function saveTabAs(tabId: string): Promise<boolean> {
  const tab = getTab(tabId);
  if (!tab) return false;
  const custom = getSaveHandler(tabId);
  if (custom) return (await custom.saveAs?.()) ?? false;
  try {
    const candidates = writable(await getHandlers(), tab);
    if (candidates.length === 0) {
      pushToast({ kind: "error", text: t("errors.readOnly"), detail: t("save.useExport") });
      return false;
    }
    const current = candidates.find((h) => h.id === tab.handlerId) ?? candidates[0];
    const ext = current?.extensions[0];
    const defaultPath = tab.path ?? (ext ? `${tab.title}.${ext}` : tab.title);
    const dest = await saveDialog({ defaultPath, filters: filtersFor(candidates) });
    if (dest === null) return false;
    const handler = pickHandler(candidates, dest, tab.handlerId);
    if (!handler) return false;
    const other = useTabs.getState().tabs.find((x) => x.id !== tabId && x.path === dest);
    if (other) {
      const ok = await confirm({
        title: t("save.replaceOpenTitle"),
        message: t("save.replaceOpenMessage", { name: other.title }),
        confirmLabel: t("save.replaceOpenConfirm"),
        danger: true,
      });
      if (!ok) return false;
    }
    const rev = tabRevision(tabId);
    const model = await currentModel(tab, true);
    await commands.saveDocument(dest, handler.id, model);
    if (tab.path && tab.path !== dest) silently(commands.unwatchFile(tab.path));
    silently(commands.watchFile(dest));
    // Pas deux onglets sur le même fichier : l'autre est fermé (son contenu vient d'être écrasé).
    for (const x of useTabs.getState().tabs.filter((y) => y.id !== tabId && y.path === dest)) {
      useTabs.getState().closeTab(x.id);
      clearTabRuntime(x.id);
      discardRecovery(x.docId);
    }
    const detected = await commands.detectFile(dest).catch(() => undefined);
    const clean = tabRevision(tabId) === rev;
    useTabs.getState().patchTab(tabId, {
      path: dest,
      title: basename(dest),
      handlerId: handler.id,
      readOnly: false,
      ...(clean ? { dirty: false } : {}),
      externalChange: false,
      capabilities: handler.capabilities,
      fidelityConfirmed: true,
      ...(detected ? { detected } : {}),
    });
    if (clean) discardRecovery(tab.docId);
    useRecent.getState().add(dest);
    pushToast({ kind: "success", text: t("save.saved", { name: basename(dest) }) });
    return true;
  } catch (e) {
    if (e instanceof SaveCancelled) return false;
    reportError(e);
    return false;
  }
}

/** Enregistrer (Ctrl+S) ; renvoie `true` si le fichier a été écrit. */
export async function saveTab(tabId: string): Promise<boolean> {
  const tab = getTab(tabId);
  if (!tab) return false;
  const custom = getSaveHandler(tabId);
  if (custom) return (await custom.save?.()) ?? false;
  if (tab.path === null || !tab.capabilities?.write) return saveTabAs(tabId);
  if (tab.externalChange) {
    const choice = await choose({
      title: t("save.externalTitle", { name: tab.title }),
      message: t("save.externalMessage"),
      actions: [
        { id: "cancel", label: t("common.cancel"), variant: "secondary" },
        { id: "reload", label: t("save.externalReload"), variant: "secondary" },
        { id: "overwrite", label: t("save.externalOverwrite"), variant: "danger" },
      ],
    });
    if (choice === "reload") {
      await reloadFromDisk(tabId, true);
      return false;
    }
    if (choice !== "overwrite") return false;
    useTabs.getState().patchTab(tabId, { externalChange: false });
  }
  if (
    tab.capabilities.fidelity === "partial" &&
    !tab.fidelityConfirmed &&
    useSettings.getState().confirmPartialSave
  ) {
    const ok = await confirm({
      title: t("save.partialTitle"),
      message: t("save.partialMessage", {
        format: tab.detected
          ? t(tab.detected.labelKey, { defaultValue: tab.handlerId })
          : tab.handlerId,
      }),
      confirmLabel: t("save.partialConfirm"),
    });
    if (!ok) return false;
    useTabs.getState().patchTab(tabId, { fidelityConfirmed: true });
  }
  try {
    const rev = tabRevision(tabId);
    const model = await currentModel(tab, true);
    await commands.saveDocument(tab.path, tab.handlerId, model);
    // Modifié pendant l'écriture : l'onglet reste « modifié ».
    if (tabRevision(tabId) === rev) {
      useTabs.getState().patchTab(tabId, { dirty: false });
      discardRecovery(tab.docId);
    }
    pushToast({ kind: "success", text: t("save.saved", { name: tab.title }) });
    return true;
  } catch (e) {
    if (e instanceof SaveCancelled) return false;
    reportError(e);
    return false;
  }
}

/** Exporter vers… : ouvre le dialogue unifié (cibles internes + moteurs externes). */
export function exportTab(tabId: string): void {
  if (getTab(tabId)) useUi.getState().setExportTabId(tabId);
}

/** Export interne : conversion du modèle courant vers le handler cible. */
export async function exportInternal(tabId: string, targetId: string): Promise<void> {
  const tab = getTab(tabId);
  if (!tab) return;
  try {
    const target = (await getHandlers()).find((h) => h.id === targetId);
    if (!target) return;
    const stem = tab.title.replace(/\.[^.]+$/, "");
    const ext = target.extensions[0];
    const dest = await saveDialog({
      defaultPath: ext ? `${stem}.${ext}` : stem,
      filters: filtersFor([target]),
    });
    if (dest === null) return;
    const model = await currentModel(tab);
    await commands.exportDocument(model, tab.handlerId, target.id, dest);
    pushToast({ kind: "success", text: t("export.done", { name: basename(dest) }) });
  } catch (e) {
    reportError(e);
  }
}

/** Export par un moteur externe : le fichier sur disque est l'entrée (enregistrement préalable). */
export async function exportExternal(
  tabId: string,
  tool: string,
  ext: string,
  formatLabel: string,
): Promise<void> {
  let tab = getTab(tabId);
  if (!tab) return;
  if (tab.dirty || tab.path === null) {
    const ok = await confirm({
      title: t("export.saveFirstTitle"),
      message: t("export.saveFirstMessage", { name: tab.title }),
      confirmLabel: t("export.saveFirstConfirm"),
    });
    if (!ok || !(await saveTab(tabId))) return;
    tab = getTab(tabId);
  }
  const src = tab?.path;
  if (!tab || !src) return;
  try {
    const stem = tab.title.replace(/\.[^.]+$/, "");
    const dest = await saveDialog({
      defaultPath: `${stem}.${ext}`,
      filters: [{ name: formatLabel, extensions: [ext] }],
    });
    if (dest === null) return;
    pushToast({ kind: "info", text: t("export.converting", { name: basename(dest) }) });
    await commands.convertExternal(tool, src, dest, ext);
    pushToast({ kind: "success", text: t("export.done", { name: basename(dest) }) });
  } catch (e) {
    reportError(e);
  }
}

/** Ferme un onglet (confirmation si modifié) ; renvoie `true` si fermé. */
export async function closeTabWithConfirm(tabId: string): Promise<boolean> {
  const tab = getTab(tabId);
  if (!tab) return true;
  if (tab.dirty) {
    useTabs.getState().activateTab(tabId);
    const choice = await choose({
      title: t("close.title", { name: tab.title }),
      message: t("close.message"),
      actions: [
        { id: "cancel", label: t("common.cancel"), variant: "secondary" },
        { id: "discard", label: t("close.discard"), variant: "danger" },
        { id: "save", label: t("close.save"), variant: "primary" },
      ],
    });
    if (choice === null || choice === "cancel") return false;
    if (choice === "save" && !(await saveTab(tabId))) return false;
  }
  useTabs.getState().closeTab(tabId);
  clearTabRuntime(tabId);
  if (tab.path) silently(commands.unwatchFile(tab.path));
  discardRecovery(tab.docId);
  return true;
}

/** Autosave de récupération des onglets modifiés. */
export async function autosaveDirtyTabs(): Promise<void> {
  // Les éditeurs à handler d'enregistrement dédié écrivent eux-mêmes : pas de récupération.
  for (const tab of useTabs.getState().tabs.filter((x) => x.dirty && !getSaveHandler(x.id))) {
    try {
      const g = gen(tab.docId);
      const model = await currentModel(tab);
      const alive = () => getTab(tab.id)?.dirty === true && gen(tab.docId) === g;
      if (!alive()) continue;
      await commands.recoveryStore(tab.docId, tab.path ?? "", model);
      // Sauvé ou fermé pendant l'écriture : on retire l'entrée qu'on vient de recréer.
      if (!alive()) silently(commands.recoveryDiscard(tab.docId));
    } catch {
      // l'autosave ne doit jamais gêner l'utilisateur
    }
  }
}

function defaultHandlerFor(
  handlers: HandlerInfo[],
  kind: DocumentModel["kind"],
): HandlerInfo | undefined {
  const preferred = NEW_DOCUMENTS.find((k) => k.modelKind === kind)?.handlerId;
  return (
    handlers.find((h) => h.id === preferred) ??
    handlers.find((h) => h.model === kind && h.capabilities.write)
  );
}

/** Restaure les documents récupérés (ouverts comme onglets modifiés). */
export async function restoreRecovery(
  entries: Awaited<ReturnType<typeof commands.recoveryList>>,
): Promise<void> {
  const handlers = await getHandlers().catch(() => [] as HandlerInfo[]);
  for (const entry of entries) {
    if (useTabs.getState().tabs.some((tab) => tab.docId === entry.docId)) continue;
    let detected: Detected | undefined;
    let capabilities: Capabilities | undefined;
    let handler: HandlerInfo | undefined;
    let path: string | null = null;
    if (entry.path !== "") {
      try {
        detected = await commands.detectFile(entry.path);
        handler = handlers.find((h) => h.id === detected?.handlerId);
        capabilities = handler?.capabilities;
        path = entry.path;
      } catch {
        // fichier d'origine disparu : on restaure comme document sans chemin
      }
    }
    const existing =
      path === null ? undefined : useTabs.getState().tabs.find((x) => x.path === path);
    if (existing) {
      // Fichier déjà ouvert : l'onglet reçoit le modèle récupéré (et reste modifié).
      clearTabRuntime(existing.id);
      useTabs.getState().reloadTab(existing.id, {
        model: entry.model,
        modelKind: entry.model.kind,
        dirty: true,
      });
      useTabs.getState().setDirty(existing.id, true);
      useTabs.getState().activateTab(existing.id);
      if (existing.docId !== entry.docId) discardRecovery(entry.docId);
      continue;
    }
    handler ??= defaultHandlerFor(handlers, entry.model.kind);
    const n = path === null ? useTabs.getState().nextUntitled() : 0;
    useTabs.getState().openTab({
      path,
      title: path === null ? t("newDoc.untitled", { n }) : basename(path),
      handlerId: handler?.id ?? detected?.handlerId ?? entry.model.kind,
      modelKind: entry.model.kind,
      readOnly: path !== null && capabilities !== undefined && !capabilities.write,
      detected,
      capabilities,
      docId: entry.docId,
      model: entry.model,
      dirty: true,
    });
    if (path) silently(commands.watchFile(path));
  }
}

export function handlerLabel(h: HandlerInfo): string {
  return label(h);
}
