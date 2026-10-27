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
  toolbar: {
    newFile: "New file",
    newDir: "New folder",
    upload: "Upload",
    refresh: "Refresh",
  },
  menu: {
    download: "Download",
    rename: "Rename",
    move: "Move",
    remove: "Delete",
    uploadHere: "Upload here",
  },
  dialog: {
    newFileTitle: "New file",
    newDirTitle: "New folder",
    renameTitle: "Rename",
    moveTitle: "Move",
    nameLabel: "Name (relative to current directory)",
    targetLabel: "Target relative path (cross-directory allowed)",
    confirm: "OK",
    cancel: "Cancel",
  },
  upload: {
    queueTitle: "Upload queue",
    uploading: "Uploading",
    done: "Done",
    failed: "Failed",
    conflict: "Target already exists",
  },
  op: {
    createFileFailed: "Failed to create file",
    createDirFailed: "Failed to create folder",
    renameFailed: "Failed to rename",
    moveFailed: "Failed to move",
    deleteFailed: "Failed to delete",
    uploadFailed: "Upload failed",
  },
} as const;
