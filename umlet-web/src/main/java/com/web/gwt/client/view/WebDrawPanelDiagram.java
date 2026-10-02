package com.web.gwt.client.view;

import com.baselet.element.interfaces.Diagram;
import com.baselet.gwt.client.view.DrawPanelDiagram;
import com.web.gwt.client.collab.CollabBridge;

public class WebDrawPanelDiagram extends DrawPanelDiagram {

    // replacing the whole diagram (file import, ?uxf= startup parameter) is a change other collaborators must see
    @Override
    public void setDiagram(Diagram diagram) {
        if (CollabBridge.get() != null) {
            CollabBridge.get().resetView();
        }
        super.setDiagram(diagram);
        if (fileChangeNotifier != null) {
            handleFileUpdate();
        }
    }
}
