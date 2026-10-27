// files 域词条（en）：与 zh/files.ts 键集一致。
export const files = {
  entry: {
    openAria: "Open file manager",
  },
  page: {
    title: "Files",
    closeAria: "Close file manager",
    placeholder: "File manager under construction",
  },
  project: {
    label: "Project",
    selectAria: "Select project",
    empty: "No registered projects",
  },
  breadcrumb: {
    root: "Root",
  },
  list: {
    heading: "Files",
    name: "Name",
    size: "Size",
    mtime: "Modified",
    type: "Type",
    empty: "This directory is empty",
    loadFailed: "Failed to load directory",
    sortByName: "Sort by name",
    sortBySize: "Sort by size",
    sortByMtime: "Sort by modified time",
    sortByType: "Sort by type",
    notAvailable: "—",
  },
  type: {
    directory: "Directory",
    file: "File",
    symlink: "Symlink",
    other: "Other",
  },
  preview: {
    empty: "Select a file to preview",
  },
  error: {
    projectsLoadFailed: "Failed to load project list",
  },
  mobile: {
    tree: "Folders",
    list: "Files",
    preview: "Preview",
    switcherAria: "Switch pane",
  },
} as const;
