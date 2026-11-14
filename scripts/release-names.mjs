// The one place that spells what a release asset is called.
//
// The packager used to name the zip `joyose-edit-<ver>-<count>[-dirty]-<sha>.zip`
// while `update.json` advertised `joyose-edit-<ver>.zip`, and every release
// depended on somebody renaming the uploaded asset by hand. A missed rename
// makes the manifest point at a 404, which the manager shows as "no update".
// Both sides now call these functions, so the names cannot drift again.

export function releaseZipName(version) {
  return `joyose-edit-${version}.zip`;
}

export function releaseZipUrl(version) {
  return `https://github.com/JiangXue5/JoyoseEdit/releases/download/${version}/${releaseZipName(version)}`;
}
