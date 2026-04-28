/* Headless X11 shims for XPPAUT WebAssembly builds.
 * These functions are intentionally no-ops so that desktop UI paths
 * can link in web/worker runtime without pulling X11.
 */

int XAllocColor(int display, int colormap, int color) { return 0; }
int XClearWindow(int display, int window) { return 0; }
int XCloseDisplay(int display) { return 0; }
int XCopyArea(int a0, int a1, int a2, int a3, int a4, int a5, int a6, int a7,
              int a8, int a9) {
  return 0;
}
int XCreateBitmapFromData(int a0, int a1, int a2, int a3, int a4) { return 0; }
int XCreatePixmap(int a0, int a1, int a2, int a3, int a4) { return 0; }
int XCreateSimpleWindow(int a0, int a1, int a2, int a3, int a4, int a5, int a6,
                        int a7, int a8) {
  return 0;
}
int XDestroySubwindows(int display, int window) { return 0; }
int XDestroyWindow(int display, int window) { return 0; }
int XDrawArc(int a0, int a1, int a2, int a3, int a4, int a5, int a6, int a7,
             int a8) {
  return 0;
}
int XDrawLine(int a0, int a1, int a2, int a3, int a4, int a5, int a6) {
  return 0;
}
int XDrawPoint(int a0, int a1, int a2, int a3, int a4) { return 0; }
int XDrawRectangle(int a0, int a1, int a2, int a3, int a4, int a5, int a6) {
  return 0;
}
int XDrawString(int a0, int a1, int a2, int a3, int a4, int a5, int a6) {
  return 0;
}
int XFillArc(int a0, int a1, int a2, int a3, int a4, int a5, int a6, int a7,
             int a8) {
  return 0;
}
int XFillRectangle(int a0, int a1, int a2, int a3, int a4, int a5, int a6) {
  return 0;
}
int XFlush(int display) { return 0; }
int XFreeGC(int display, int gc) { return 0; }
int XFreePixmap(int display, int pixmap) { return 0; }
int XGetGeometry(int a0, int a1, int a2, int a3, int a4, int a5, int a6,
                 int a7, int a8) {
  return 0;
}
int XGetInputFocus(int a0, int a1, int a2) { return 0; }
int XLookupString(int a0, int a1, int a2, int a3, int a4) { return 0; }
int XMapWindow(int display, int window) { return 0; }
int XMoveResizeWindow(int a0, int a1, int a2, int a3, int a4, int a5) {
  return 0;
}
int XNextEvent(int display, int event) { return 0; }
int XParseColor(int a0, int a1, int a2, int a3) { return 0; }
int XPending(int display) { return 0; }
int XResizeWindow(int a0, int a1, int a2, int a3) { return 0; }
int XSelectInput(int a0, int a1, int a2) { return 0; }
int XSetBackground(int a0, int a1, int a2) { return 0; }
int XSetDashes(int a0, int a1, int a2, int a3, int a4) { return 0; }
int XSetFont(int a0, int a1, int a2) { return 0; }
int XSetForeground(int a0, int a1, int a2) { return 0; }
int XSetFunction(int a0, int a1, int a2) { return 0; }
int XSetLineAttributes(int a0, int a1, int a2, int a3, int a4, int a5) {
  return 0;
}
void XSetWMName(int a0, int a1, int a2) {}
void XSetWMProperties(int a0, int a1, int a2, int a3, int a4, int a5, int a6,
                      int a7, int a8) {}
int XSetWMProtocols(int a0, int a1, int a2, int a3) { return 0; }
int XSetWindowBackgroundPixmap(int a0, int a1, int a2) { return 0; }
int XSetWindowBorderWidth(int a0, int a1, int a2) { return 0; }
int XStringListToTextProperty(int a0, int a1, int a2) { return 0; }
int XTextWidth(int a0, int a1, int a2) { return 0; }
int XUnloadFont(int a0, int a1) { return 0; }
int XkbBell(int a0, int a1, int a2, int a3) { return 0; }
