import { createPreviewVisualComment } from '../../src/preview-comment-types';
export const comment = (id = 'one') =>
  createPreviewVisualComment({
    id,
    turnId: 'turn-a',
    body: 'Synthetic comment',
    authorId: 'local:test',
    createdAt: 1,
    anchor: {
      version: 1,
      page: {
        url: 'http://localhost/',
        pathname: '/',
        viewport: { width: 100, height: 100, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
      },
      click: {
        clientX: 1,
        clientY: 1,
        pageX: 1,
        pageY: 1,
        viewportXRatio: 0.01,
        viewportYRatio: 0.01,
      },
      target: {
        tag: 'div',
        attributes: {},
        rect: { x: 0, y: 0, width: 1, height: 1 },
        rectRatio: { x: 0, y: 0, width: 0.01, height: 0.01 },
        selector: '#test',
      },
      context: { ancestors: [] },
    },
  });
