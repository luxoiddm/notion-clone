import { create } from 'zustand';

interface WorkspaceState {
  projectId: string | null;
  activeOwnerId: string | null;
  activeProjectId: string | null;
  activePageId: string | null;
  setProjectId: (projectId: string | null) => void;
  /** Opens a page for viewing/editing — sets owner, project, and page together so they never drift out of sync. */
  openPage: (ownerId: string, projectId: string, pageId: string) => void;
  /** Clears the currently open page (e.g. after deleting it) so the workspace falls back to the empty state. */
  clearActivePage: () => void;
}

export const useUserStore = create<WorkspaceState>((set) => ({
  projectId: null,
  activeOwnerId: null,
  activeProjectId: null,
  activePageId: null,
  setProjectId: (projectId) => set({ projectId }),
  openPage: (ownerId, projectId, pageId) => set({ activeOwnerId: ownerId, activeProjectId: projectId, activePageId: pageId }),
  clearActivePage: () => set({ activeOwnerId: null, activeProjectId: null, activePageId: null }),
}));
