package com.web.gwt.client.file;

import com.baselet.gwt.client.file.FileChangeNotifier;
import com.web.gwt.client.collab.CollabBridge;

public class WebFileChangeNotifier implements FileChangeNotifier {
    @Override
    public void notifyFileChange(String diagramXMLState) {
        notifyCollab(false);
    }

    @Override
    public void notifyPossibleChange() {
        notifyCollab(true);
    }

    @Override
    public void beforeViewChange() {
        if (CollabBridge.get() != null) {
            CollabBridge.get().beforeViewChange();
        }
    }

    @Override
    public void afterViewChange() {
        if (CollabBridge.get() != null) {
            CollabBridge.get().afterViewChange();
        }
    }

    // tells the collaboration client (collab.js) that the diagram changed; it pulls the changed elements via umletCollabSnapshot()
    private native void notifyCollab(boolean live) /*-{
        if ($wnd.umletCollab && $wnd.umletCollab.onLocalChange) {
            $wnd.umletCollab.onLocalChange(live);
        }
    }-*/;
}
