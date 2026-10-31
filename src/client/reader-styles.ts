import reader from './reader.css'
import settings from './settings.css'
import sidebar from './reading-sidebar.css'
import pages from './windowed-pages.css'
import comments from './annotation-comment-card.css'
import glass from './glass.css'

/** The installed reader and its browser benchmark use the same ordered stylesheet. */
export const readerStyles = [reader, settings, sidebar, pages, comments, glass].join('\n')
