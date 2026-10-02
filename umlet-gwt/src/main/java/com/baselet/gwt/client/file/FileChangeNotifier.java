package com.baselet.gwt.client.file;

public interface FileChangeNotifier {
	void notifyFileChange(String diagramXMLState);

	/* called on every redraw and while elements are dragged: the diagram may have changed (cheap, may be called often); used for live collaboration */
	default void notifyPossibleChange() {}

	/* called around operations that move all elements only to change the view (zoom, pan, canvas realignment) */
	default void beforeViewChange() {}

	default void afterViewChange() {}

	/* the mouse button was released after pressing it on the diagram; moved: whether anything was dragged */
	default void pointerReleased(boolean moved) {}
}
