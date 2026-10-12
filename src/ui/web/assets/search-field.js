// Keep the focused search API; primitives share dom.js's startup chunk rather than
// creating a request per small cross-page helper.
export { searchField, noticeSearchText } from './dom.js';
