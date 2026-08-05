/**
 * DOM renderers for the learning UI (courses, lessons, steps).
 */
import type {
  AttemptResultView,
  CourseProgressSummaryView,
  CourseView,
  LessonView,
  StepView,
} from '../api/models.js';
import { mountBoard } from './board.js';
import { difficultyLabel, courseProgressLabel, stepStatusLabel } from './learning-helpers.js';
import { renderEmpty } from './render-helpers.js';

/**
 * Render the list of published courses.
 */
export function renderCourseList(container: HTMLElement, courses: readonly CourseView[]): void {
  container.innerHTML = '';
  if (courses.length === 0) {
    renderEmpty(container, {
      mark: '♟',
      title: 'No courses available',
      body: 'Check back later for new learning content.',
      inline: true,
    });
    return;
  }

  for (const course of courses) {
    const row = document.createElement('div');
    row.className = 'panel-row';

    const main = document.createElement('div');
    main.className = 'row-main';

    const titleLink = document.createElement('a');
    titleLink.href = `/courses/${encodeURIComponent(course.slug)}`;
    titleLink.dataset.route = 'course';
    titleLink.textContent = course.title;
    main.appendChild(titleLink);

    if (course.description) {
      const desc = document.createElement('span');
      desc.className = 'count';
      desc.textContent = course.description;
      main.appendChild(desc);
    }
    row.appendChild(main);

    const difficulty = document.createElement('span');
    difficulty.className = 'count';
    difficulty.textContent = difficultyLabel(course.difficulty);
    row.appendChild(difficulty);

    container.appendChild(row);
  }
}

/**
 * Render course details and its lesson list.
 */
export function renderCourseDetail(
  container: HTMLElement,
  course: CourseView,
  lessons: readonly LessonView[],
  progress: CourseProgressSummaryView | null,
): void {
  const titleEl = container.querySelector('#course-title');
  const descEl = container.querySelector('#course-description');
  const progressEl = container.querySelector('#course-progress');
  const listEl = container.querySelector('#lesson-list');

  if (titleEl) titleEl.textContent = course.title;
  if (descEl) descEl.textContent = course.description;
  if (progressEl) progressEl.textContent = courseProgressLabel(progress);

  if (!listEl) return;
  listEl.innerHTML = '';

  if (lessons.length === 0) {
    renderEmpty(listEl as HTMLElement, {
      title: 'No lessons in this course',
      body: 'This course has no lessons yet.',
      inline: true,
    });
    return;
  }

  for (const lesson of lessons) {
    const row = document.createElement('div');
    row.className = 'panel-row';

    const main = document.createElement('div');
    main.className = 'row-main';

    const link = document.createElement('a');
    link.href = `/lessons/${encodeURIComponent(lesson.id)}`;
    link.dataset.route = 'lesson';
    link.textContent = `Lesson ${lesson.orderIndex + 1}: ${lesson.title}`;
    main.appendChild(link);
    row.appendChild(main);

    listEl.appendChild(row);
  }
}

/**
 * Render lesson details and all steps on one scrolling page.
 */
export function renderLessonDetail(
  container: HTMLElement,
  lesson: LessonView,
  steps: readonly StepView[],
  progress: CourseProgressSummaryView | null,
  stepAttempts: ReadonlyMap<string, AttemptResultView>,
  onAttemptSubmit: (stepId: string, input: { san?: string; selectedIndex?: number }) => Promise<void>,
): void {
  const titleEl = container.querySelector('#lesson-title');
  const progressEl = container.querySelector('#lesson-progress');
  const stepListEl = container.querySelector('#step-list');

  if (titleEl) titleEl.textContent = lesson.title;
  if (progressEl) progressEl.textContent = courseProgressLabel(progress);

  if (!stepListEl) return;
  stepListEl.innerHTML = '';

  if (steps.length === 0) {
    renderEmpty(stepListEl as HTMLElement, {
      title: 'No steps in this lesson',
      body: 'This lesson has no steps yet.',
      inline: true,
    });
    return;
  }

  for (const step of steps) {
    const block = document.createElement('div');
    block.className = 'step-block';
    block.dataset.stepId = step.id;

    const header = document.createElement('div');
    header.className = 'step-header';

    const numberLabel = document.createElement('span');
    numberLabel.className = 'step-number count';
    numberLabel.textContent = `Step ${step.orderIndex + 1}`;
    header.appendChild(numberLabel);

    const statusLabel = document.createElement('span');
    statusLabel.className = 'step-status count';
    statusLabel.textContent = stepStatusLabel(stepAttempts.get(step.id));
    header.appendChild(statusLabel);

    block.appendChild(header);

    if (step.kind === 'text') {
      const prose = document.createElement('div');
      prose.className = 'step-prose';
      prose.textContent = step.prose;
      block.appendChild(prose);

      const actions = document.createElement('div');
      actions.className = 'step-actions';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'step-complete-btn';
      btn.textContent = 'Complete';
      btn.addEventListener('click', () => {
        btn.disabled = true;
        void onAttemptSubmit(step.id, {}).then(() => {
          btn.disabled = false;
        });
      });
      actions.appendChild(btn);
      block.appendChild(actions);
    } else if (step.kind === 'move') {
      const boardContainer = document.createElement('div');
      boardContainer.className = 'step-board-wrapper';
      boardContainer.setAttribute('role', 'region');
      boardContainer.setAttribute('aria-label', `Chess board position for Step ${step.orderIndex + 1} (read-only)`);

      const boardDesc = document.createElement('p');
      boardDesc.className = 'sr-only';
      boardDesc.textContent = `Static chess position FEN: ${step.fen}. Non-interactive board.`;
      boardContainer.appendChild(boardDesc);

      const boardEl = document.createElement('div');
      boardEl.className = 'step-board';
      boardContainer.appendChild(boardEl);
      block.appendChild(boardContainer);

      // Mount read-only board
      const mounted = mountBoard({ boardEl });
      mounted.setTurn(false);
      mounted.setPosition(step.fen);

      if (step.hint) {
        const hint = document.createElement('p');
        hint.className = 'step-hint count';
        hint.textContent = step.hint;
        block.appendChild(hint);
      }

      const form = document.createElement('form');
      form.className = 'step-form';

      const label = document.createElement('label');
      label.className = 'sr-only';
      label.htmlFor = `san-input-${step.id}`;
      label.textContent = 'SAN move';
      form.appendChild(label);

      const input = document.createElement('input');
      input.id = `san-input-${step.id}`;
      input.type = 'text';
      input.className = 'step-san-input';
      input.placeholder = 'e.g. Nf3';
      input.autocomplete = 'off';
      input.required = true;
      form.appendChild(input);

      const submitBtn = document.createElement('button');
      submitBtn.type = 'submit';
      submitBtn.textContent = 'Submit move';
      form.appendChild(submitBtn);

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const san = input.value.trim();
        if (!san) return;
        submitBtn.disabled = true;
        input.disabled = true;
        void onAttemptSubmit(step.id, { san }).then(() => {
          submitBtn.disabled = false;
          input.disabled = false;
        });
      });

      block.appendChild(form);
    } else if (step.kind === 'quiz') {
      const question = document.createElement('div');
      question.className = 'step-question';
      question.textContent = step.question;
      block.appendChild(question);

      const optionsGroup = document.createElement('div');
      optionsGroup.className = 'step-quiz-options';
      optionsGroup.setAttribute('role', 'group');
      optionsGroup.setAttribute('aria-label', step.question);

      step.options.forEach((optionText, idx) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'quiz-option-btn';
        btn.textContent = optionText;
        btn.addEventListener('click', () => {
          optionsGroup.querySelectorAll('button').forEach((b) => (b.disabled = true));
          void onAttemptSubmit(step.id, { selectedIndex: idx }).then(() => {
            optionsGroup.querySelectorAll('button').forEach((b) => (b.disabled = false));
          });
        });
        optionsGroup.appendChild(btn);
      });

      block.appendChild(optionsGroup);
    }

    stepListEl.appendChild(block);
  }
}
