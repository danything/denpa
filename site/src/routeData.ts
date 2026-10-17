/*
 * Starlight のルートミドルウェア (astro.config.ts の routeMiddleware)。
 * 文書のページの <head> にパンくずの構造化データを足す (src/data/structured-data.ts)
 */
import { defineRouteMiddleware } from '@astrojs/starlight/route-data';
import { breadcrumb } from './data/structured-data.ts';

export const onRequest = defineRouteMiddleware((context) => {
    const route = context.locals.starlightRoute;
    const crumb = breadcrumb(route.sidebar, route.entry.data.title);
    if (crumb) route.head.push(crumb);
});
