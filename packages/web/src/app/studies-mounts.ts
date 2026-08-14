import type { GambitClient } from '../api/client.js';
import { mountBoard } from './board.js';
import type { MountedBoard } from './board.js';
import { StudiesController } from './studies-controller.js';
import type { StudiesCallbacks } from './studies-controller.js';
import { renderChapterDetail, renderStudyDetail, renderStudyList } from './studies-view.js';

interface StudiesListMountDependencies {
  readonly doc: Document;
  readonly client: GambitClient;
  readonly surface: HTMLElement;
}

interface StudyDetailMountDependencies extends StudiesListMountDependencies {
  readonly studyId: string;
}

interface StudyChapterMountDependencies extends StudyDetailMountDependencies {
  readonly chapterId: string;
}

interface MountedStudyChapter {
  readonly board: MountedBoard | null;
  readonly studies: StudiesController;
}

interface StudiesListElements {
  readonly list: HTMLElement | null;
  readonly error: HTMLElement | null;
  readonly searchForm: HTMLFormElement | null;
}

interface StudyDetailElements {
  readonly nameEl: HTMLElement | null;
  readonly descEl: HTMLElement | null;
  readonly visEl: HTMLElement | null;
  readonly exportEl: HTMLAnchorElement | null;
  readonly chaptersEl: HTMLElement | null;
  readonly collabsEl: HTMLElement | null;
  readonly error: HTMLElement | null;
}

interface StudyChapterElements {
  readonly studyLinkEl: HTMLAnchorElement | null;
  readonly chapterNameEl: HTMLElement | null;
  readonly exportEl: HTMLAnchorElement | null;
  readonly treeEl: HTMLElement | null;
  readonly navEl: HTMLElement | null;
  readonly error: HTMLElement | null;
}

function renderUnavailable(doc: Document, surface: HTMLElement): void {
  surface.replaceChildren();
  const message = doc.createElement('p');
  message.className = 'count';
  message.textContent = 'Studies service unavailable.';
  surface.appendChild(message);
}

function studiesListElements(doc: Document): StudiesListElements {
  return {
    list: doc.getElementById('study-list'),
    error: doc.getElementById('studies-error'),
    searchForm: doc.getElementById('study-search-form') as HTMLFormElement | null,
  };
}

function createStudiesListCallbacks(
  elements: StudiesListElements,
  showUnavailable: () => void,
): StudiesCallbacks {
  return {
    onStudyList: (studies) => {
      if (elements.error) elements.error.textContent = '';
      if (elements.list) renderStudyList(elements.list, studies);
    },
    onStudy: () => {},
    onChapterDetail: () => {},
    onLoading: (loading) => {
      if (elements.list) elements.list.setAttribute('aria-busy', loading ? 'true' : 'false');
    },
    onError: (message) => {
      if (elements.error) elements.error.textContent = message;
    },
    onUnavailable: showUnavailable,
  };
}

function bindStudySearch(
  doc: Document,
  form: HTMLFormElement | null,
  controller: StudiesController,
): void {
  if (!form) return;
  // The form lives in persistent index markup, so assignment makes the latest route its sole owner.
  form.onsubmit = (event): void => {
    event.preventDefault();
    const input = doc.getElementById('study-search-input') as HTMLInputElement | null;
    const query = input?.value.trim() ?? '';
    void controller.loadStudies(query);
  };
}

export function mountStudiesList({
  doc,
  client,
  surface,
}: StudiesListMountDependencies): StudiesController {
  const elements = studiesListElements(doc);
  const controller = new StudiesController({
    client,
    callbacks: createStudiesListCallbacks(elements, () => renderUnavailable(doc, surface)),
  });
  bindStudySearch(doc, elements.searchForm, controller);
  void controller.loadStudies();
  return controller;
}

function studyDetailElements(doc: Document): StudyDetailElements {
  return {
    nameEl: doc.getElementById('study-name'),
    descEl: doc.getElementById('study-description'),
    visEl: doc.getElementById('study-visibility'),
    exportEl: doc.getElementById('study-export-link') as HTMLAnchorElement | null,
    chaptersEl: doc.getElementById('study-chapters'),
    collabsEl: doc.getElementById('study-collaborators'),
    error: doc.getElementById('study-error'),
  };
}

function createStudyDetailCallbacks(
  elements: StudyDetailElements,
  showUnavailable: () => void,
): StudiesCallbacks {
  return {
    onStudyList: () => {},
    onStudy: (study, chapters, collaborators, exportUrl) => {
      if (elements.error) elements.error.textContent = '';
      renderStudyDetail(elements, study, chapters, collaborators, exportUrl);
    },
    onChapterDetail: () => {},
    onLoading: (loading) => {
      if (elements.chaptersEl) {
        elements.chaptersEl.setAttribute('aria-busy', loading ? 'true' : 'false');
      }
    },
    onError: (message) => {
      if (elements.error) elements.error.textContent = message;
    },
    onUnavailable: showUnavailable,
  };
}

export function mountStudyDetail({
  doc,
  client,
  surface,
  studyId,
}: StudyDetailMountDependencies): StudiesController {
  const elements = studyDetailElements(doc);
  const controller = new StudiesController({
    client,
    callbacks: createStudyDetailCallbacks(elements, () => renderUnavailable(doc, surface)),
  });
  void controller.loadStudy(studyId);
  return controller;
}

function studyChapterElements(doc: Document): StudyChapterElements {
  return {
    studyLinkEl: doc.getElementById('chapter-study-link') as HTMLAnchorElement | null,
    chapterNameEl: doc.getElementById('chapter-name'),
    exportEl: doc.getElementById('chapter-export-link') as HTMLAnchorElement | null,
    treeEl: doc.getElementById('chapter-tree'),
    navEl: doc.getElementById('chapter-list-nav'),
    error: doc.getElementById('study-chapter-error'),
  };
}

function createStudyChapterCallbacks(
  elements: StudyChapterElements,
  board: MountedBoard | null,
  showUnavailable: () => void,
): StudiesCallbacks {
  return {
    onStudyList: () => {},
    onStudy: () => {},
    onChapterDetail: (study, chapter, tree, chapters, exportUrl) => {
      if (elements.error) elements.error.textContent = '';
      board?.setPosition(chapter.startingFen);
      renderChapterDetail(elements, study, chapter, tree, chapters, exportUrl, (fenAfter) => {
        board?.setPosition(fenAfter);
      });
    },
    onLoading: (loading) => {
      if (elements.treeEl) elements.treeEl.setAttribute('aria-busy', loading ? 'true' : 'false');
    },
    onError: (message) => {
      if (elements.error) elements.error.textContent = message;
    },
    onUnavailable: showUnavailable,
  };
}

export function mountStudyChapter({
  doc,
  client,
  surface,
  studyId,
  chapterId,
}: StudyChapterMountDependencies): MountedStudyChapter {
  const boardElement = doc.getElementById('chapter-board');
  const board = boardElement ? mountBoard({ boardEl: boardElement }) : null;
  board?.setTurn(false);

  const controller = new StudiesController({
    client,
    callbacks: createStudyChapterCallbacks(
      studyChapterElements(doc),
      board,
      () => renderUnavailable(doc, surface),
    ),
  });
  void controller.loadChapter(studyId, chapterId);
  return { board, studies: controller };
}
