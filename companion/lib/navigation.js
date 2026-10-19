// When the shared tab starts loading another page. The capture is of the whole tab, cropped to the
// video's rectangle as the last survey (one a second) found it: until the next one, that rectangle
// would crop the new page instead. So the rectangle is dropped as soon as the tab starts loading,
// and the receivers keep the last frame of the video until a survey finds one again.

/** True when `changeInfo` (chrome.tabs.onUpdated) says the shared tab `tabId` started loading. */
export function navigationClearsRect(share, tabId, changeInfo) {
  return Boolean(share) && share.tabId === tabId && changeInfo?.status === 'loading'
}
