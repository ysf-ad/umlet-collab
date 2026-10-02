package com.web.gwt.client.file;

import com.baselet.gwt.client.file.FileChangeNotifier;

public class WebFileChangeNotifier implements FileChangeNotifier {
    @Override
    public void notifyFileChange(String diagramXMLState) {
        notifyCollab(diagramXMLState);
    }

    // forwards the diagram to the collaboration client (collab.js) if it is loaded
    private native void notifyCollab(String xml) /*-{
        if ($wnd.umletCollab && $wnd.umletCollab.onLocalChange) {
            $wnd.umletCollab.onLocalChange(xml);
        }
    }-*/;
}
