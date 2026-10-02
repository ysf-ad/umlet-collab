package com.web.gwt.client.collab;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.baselet.control.basics.geom.Rectangle;
import com.baselet.control.constants.SharedConstants;
import com.baselet.control.enums.ElementId;
import com.baselet.element.Selector;
import com.baselet.element.interfaces.Diagram;
import com.baselet.element.interfaces.GridElement;
import com.baselet.element.relation.Relation;
import com.baselet.gwt.client.element.ElementFactoryGwt;
import com.baselet.gwt.client.element.GridElementZoomUtil;
import com.baselet.gwt.client.view.DrawPanelDiagram;
import com.baselet.gwt.client.view.MainView;
import com.google.gwt.core.client.JavaScriptObject;
import com.google.gwt.core.client.JsArray;

/**
 * Bridge between the GWT diagram and collab.js.
 *
 * Every element gets a stable random id (kept in memory only, so exported .uxf files stay unchanged).
 * Records exchanged with JS are plain objects {id, type, x, y, w, h, pa, aa, deleted}, always at the
 * default zoom level so users with different zoom levels see the same diagram.
 * The diagram help text is synced as a record with id {@link #DIAGRAM_ID}.
 *
 * UMLet has no camera, zoom/pan/canvas realignment move all elements. Those view changes are absorbed into a local
 * view offset (viewX/viewY, in local pixels) so they are not sent to other users: shared = (local - view) at default zoom.
 */
public class CollabBridge {

	private static final String DIAGRAM_ID = "_diagram";

	private static CollabBridge current;

	private final MainView mainView;
	// remote records for elements the local user is holding with the mouse (applied on release unless the user dragged)
	private final Map<String, JavaScriptObject> heldBack = new LinkedHashMap<String, JavaScriptObject>();
	private int viewX, viewY;
	// reference element and its shared position (at default zoom) captured before a view change
	private GridElement viewRef;
	private double viewRefSharedX, viewRefSharedY;
	private final Map<GridElement, String> idByElement = new IdentityHashMap<GridElement, String>();
	private final Map<String, GridElement> elementById = new HashMap<String, GridElement>();

	public CollabBridge(MainView mainView) {
		this.mainView = mainView;
		current = this;
	}

	public static CollabBridge get() {
		return current;
	}

	public void beforeViewChange() {
		List<GridElement> elements = panel().getDiagram().getGridElements();
		viewRef = elements.isEmpty() ? null : elements.get(0);
		if (viewRef != null) {
			double toDefault = SharedConstants.DEFAULT_GRID_SIZE / (double) zoomLevel();
			viewRefSharedX = (viewRef.getRectangle().getX() - viewX) * toDefault;
			viewRefSharedY = (viewRef.getRectangle().getY() - viewY) * toDefault;
		}
	}

	public void afterViewChange() {
		if (viewRef != null && panel().getDiagram().getGridElements().contains(viewRef)) {
			double toLocal = zoomLevel() / (double) SharedConstants.DEFAULT_GRID_SIZE;
			viewX = viewRef.getRectangle().getX() - (int) Math.round(viewRefSharedX * toLocal);
			viewY = viewRef.getRectangle().getY() - (int) Math.round(viewRefSharedY * toLocal);
		}
		viewRef = null;
	}

	public void pointerReleased(boolean moved) {
		if (heldBack.isEmpty()) {
			return;
		}
		JsArray<JavaScriptObject> records = JavaScriptObject.createArray().cast();
		for (JavaScriptObject rec : heldBack.values()) {
			records.push(rec);
		}
		heldBack.clear();
		if (!moved) { // only clicked: show what the others changed meanwhile. If dragged, the local change wins (it is sent with a higher version)
			apply(records, false);
		}
	}

	/* a newly loaded diagram (import, ?uxf=) defines the shared coordinates itself */
	public void resetView() {
		viewX = 0;
		viewY = 0;
	}

	private DrawPanelDiagram panel() {
		return mainView.diagramPanel;
	}

	private String idOf(GridElement ge) {
		String id = idByElement.get(ge);
		if (id == null) {
			id = randomId();
			register(ge, id);
		}
		return id;
	}

	private void register(GridElement ge, String id) {
		idByElement.put(ge, id);
		elementById.put(id, ge);
	}

	/* all elements of the current diagram as records (normalized to the default zoom level) */
	JsArray<JavaScriptObject> snapshot() {
		Diagram diagram = panel().getDiagram();
		int zoom = diagram.getZoomLevel();
		JsArray<JavaScriptObject> result = JavaScriptObject.createArray().cast();
		String helpText = diagram.getPanelAttributes();
		result.push(record(DIAGRAM_ID, DIAGRAM_ID, 0, 0, 0, 0, helpText == null ? "" : helpText, ""));
		for (GridElement ge : diagram.getGridElements()) {
			if (panel().isPreviewElement(ge)) {
				continue;
			}
			// plain arithmetic: copying the element and zooming the copy runs element logic (e.g. re-centering) that
			// makes the result depend on the zoom level. Relation points (additional attributes) are zoom independent.
			Rectangle r = ge.getRectangle();
			double toDefault = SharedConstants.DEFAULT_GRID_SIZE / (double) zoom;
			result.push(record(idOf(ge), ge.getId().name(),
					(int) Math.round((r.getX() - viewX) * toDefault), (int) Math.round((r.getY() - viewY) * toDefault),
					(int) Math.round(r.getWidth() * toDefault), (int) Math.round(r.getHeight() * toDefault),
					ge.getPanelAttributes(), ge.getAdditionalAttributes()));
		}
		return result;
	}

	/* applies remote records in place (keeps selection, drag state and object identity). replaceAll removes every element not contained in records */
	void apply(JsArray<JavaScriptObject> records, boolean replaceAll) {
		DrawPanelDiagram panel = panel();
		Diagram diagram = panel.getDiagram();
		int zoom = diagram.getZoomLevel();
		Selector selector = panel.getSelector();
		List<GridElement> current = diagram.getGridElements();
		List<GridElement> selected = selector.getSelectedElements();
		GridElement shownInPropertiesPanel = selected.isEmpty() ? null : selected.get(selected.size() - 1);

		List<GridElement> toAdd = new ArrayList<GridElement>();
		List<GridElement> toRemove = new ArrayList<GridElement>();
		Set<String> seen = new HashSet<String>();
		boolean updatePropertiesPanel = false;

		for (int i = 0; i < records.length(); i++) {
			JavaScriptObject rec = records.get(i);
			String id = str(rec, "id");
			seen.add(id);
			if (DIAGRAM_ID.equals(id)) {
				String helpText = str(rec, "pa");
				if (!helpText.equals(diagram.getPanelAttributes())) {
					diagram.setPanelAttributes(helpText);
					updatePropertiesPanel |= shownInPropertiesPanel == null;
				}
				continue;
			}

			GridElement existing = elementById.get(id);
			boolean inDiagram = existing != null && current.contains(existing);
			if (bool(rec, "deleted")) {
				if (inDiagram) {
					toRemove.add(existing);
				}
				continue;
			}
			if (inDiagram && panel.isPointerDown() && selector.isSelected(existing)) {
				heldBack.put(id, rec); // never change an element under the local user's mouse (see pointerReleased)
				continue;
			}

			GridElement incoming = createElement(rec, diagram, zoom);
			incoming.setLocationDifference(viewX, viewY);
			if (inDiagram && existing.getId() == incoming.getId()) {
				if (!existing.getPanelAttributes().equals(incoming.getPanelAttributes())) {
					existing.setPanelAttributes(incoming.getPanelAttributes());
					updatePropertiesPanel |= existing == shownInPropertiesPanel;
				}
				Rectangle target = incoming.getRectangle();
				boolean pointsChanged = !existing.getAdditionalAttributes().equals(incoming.getAdditionalAttributes());
				if (existing instanceof Relation) {
					// a relation's size follows from its points: set the position, then the points (which resizes it)
					if (pointsChanged || existing.getRectangle().getX() != target.getX() || existing.getRectangle().getY() != target.getY()) {
						existing.setLocation(target.getX(), target.getY());
						existing.setAdditionalAttributes(incoming.getAdditionalAttributes());
					}
				}
				else {
					existing.setRectangle(target);
					if (pointsChanged) {
						existing.setAdditionalAttributes(incoming.getAdditionalAttributes());
					}
				}
				// elements cache their drawing; without this a relation keeps drawing its old shape (and is not
				// clickable where it is drawn, because hit testing already uses the new points)
				existing.updateModelFromText();
			}
			else { // new element, or the element type changed
				if (inDiagram) {
					toRemove.add(existing);
				}
				register(incoming, id);
				toAdd.add(incoming);
			}
		}

		if (replaceAll) {
			for (GridElement ge : current) {
				if (!seen.contains(idOf(ge)) && !panel.isPreviewElement(ge)) {
					toRemove.add(ge);
				}
			}
		}

		if (!toRemove.isEmpty()) {
			updatePropertiesPanel |= toRemove.contains(shownInPropertiesPanel);
			panel.removeGridElementsDontNotifyUpdate(toRemove); // also deselects them
		}
		current.addAll(toAdd); // not via addGridElements(), which would select the new elements
		if (updatePropertiesPanel) {
			panel.updatePropertiesPanelWithSelectedElement();
		}
		panel.redraw(!toAdd.isEmpty() || !toRemove.isEmpty());
	}

	private static GridElement createElement(JavaScriptObject rec, Diagram diagram, int zoom) {
		Rectangle rect = new Rectangle(num(rec, "x"), num(rec, "y"), num(rec, "w"), num(rec, "h"));
		GridElement ge = ElementFactoryGwt.create(ElementId.valueOf(str(rec, "type")), rect, str(rec, "pa"), str(rec, "aa"), diagram);
		GridElementZoomUtil.zoomEntities(SharedConstants.DEFAULT_GRID_SIZE, zoom, Collections.singletonList(ge));
		return ge;
	}

	/* ids of the locally selected elements */
	JsArray<JavaScriptObject> selection() {
		JsArray<JavaScriptObject> result = JavaScriptObject.createArray().cast();
		for (GridElement ge : panel().getSelector().getSelectedElements()) {
			if (!panel().isPreviewElement(ge)) {
				pushString(result, idOf(ge));
			}
		}
		return result;
	}

	/* id of the element whose text is shown in the properties panel (the diagram itself if nothing is selected) */
	String propertiesId() {
		List<GridElement> selected = panel().getSelector().getSelectedElements();
		return selected.isEmpty() ? DIAGRAM_ID : idOf(selected.get(selected.size() - 1));
	}

	/* local canvas rectangle (in px, includes zoom and view offset) of an element, or null */
	JavaScriptObject localRect(String id) {
		GridElement ge = elementById.get(id);
		if (ge == null || !panel().getDiagram().getGridElements().contains(ge)) {
			return null;
		}
		Rectangle r = ge.getRectangle();
		return record(id, "", r.getX(), r.getY(), r.getWidth(), r.getHeight(), "", "");
	}

	JavaScriptObject canvasElement() {
		return panel().getCanvasElement();
	}

	int zoomLevel() {
		return panel().getDiagram().getZoomLevel();
	}

	int viewX() {
		return viewX;
	}

	int viewY() {
		return viewY;
	}

	public native void export() /*-{
		var that = this;
		$wnd.umletCollabSnapshot = $entry(function() {
			return that.@com.web.gwt.client.collab.CollabBridge::snapshot()();
		});
		$wnd.umletCollabApply = $entry(function(records, replaceAll) {
			that.@com.web.gwt.client.collab.CollabBridge::apply(Lcom/google/gwt/core/client/JsArray;Z)(records, !!replaceAll);
		});
		$wnd.umletCollabView = $entry(function() {
			return {
				zoom: that.@com.web.gwt.client.collab.CollabBridge::zoomLevel()(),
				x: that.@com.web.gwt.client.collab.CollabBridge::viewX()(),
				y: that.@com.web.gwt.client.collab.CollabBridge::viewY()()
			};
		});
		$wnd.umletCollabCanvas = $entry(function() {
			return that.@com.web.gwt.client.collab.CollabBridge::canvasElement()();
		});
		$wnd.umletCollabSelection = $entry(function() {
			return that.@com.web.gwt.client.collab.CollabBridge::selection()();
		});
		$wnd.umletCollabPropertiesId = $entry(function() {
			return that.@com.web.gwt.client.collab.CollabBridge::propertiesId()();
		});
		$wnd.umletCollabRect = $entry(function(id) {
			return that.@com.web.gwt.client.collab.CollabBridge::localRect(Ljava/lang/String;)(id);
		});
		if ($wnd.umletCollab && $wnd.umletCollab.onReady) {
			$wnd.umletCollab.onReady();
		}
	}-*/;

	private static native JavaScriptObject record(String id, String type, int x, int y, int w, int h, String pa, String aa) /*-{
		return { id: id, type: type, x: x, y: y, w: w, h: h, pa: pa, aa: aa };
	}-*/;

	private static native void pushString(JsArray<JavaScriptObject> array, String value) /*-{
		array.push(value);
	}-*/;

	private static native String str(JavaScriptObject o, String key) /*-{
		var v = o[key];
		return v == null ? "" : String(v);
	}-*/;

	private static native int num(JavaScriptObject o, String key) /*-{
		return o[key] | 0;
	}-*/;

	private static native boolean bool(JavaScriptObject o, String key) /*-{
		return !!o[key];
	}-*/;

	private static native String randomId() /*-{
		return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
	}-*/;
}
