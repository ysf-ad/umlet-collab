package com.web.gwt.client.view.utils;

import com.baselet.gwt.client.element.DiagramXmlParser;
import com.baselet.gwt.client.view.MainView;
import com.baselet.gwt.client.view.utils.StartupDiagramLoader;
import com.google.gwt.http.client.*;
import com.google.gwt.user.client.Window;

public class WebStartupDiagramLoader implements StartupDiagramLoader {

    @Override
    public void loadDiagram(MainView mainView) {
        exportCollabApi(mainView);

        // if uxf parameter is set, a GET request is made to get and load the diagram from the specified URL
        String urlOrUxf = Window.Location.getParameter("uxf");
        if (urlOrUxf == null) {
            return;
        }

        if (urlOrUxf.startsWith("<")) {
            setLoadResult(mainView, urlOrUxf);
        } else {
            RequestBuilder builder = new RequestBuilder(RequestBuilder.GET, urlOrUxf);
            try {
                builder.sendRequest(null, new RequestCallback() {
                    @Override
                    public void onError(Request request, Throwable exception) {
                        if (exception instanceof RequestTimeoutException) {
                            Window.alert("The request has timed out");
                        } else {
                            Window.alert(exception.getMessage());
                        }
                    }

                    @Override
                    public void onResponseReceived(Request request, Response response) {
                        int STATUS_CODE_OK = 200;
                        if (STATUS_CODE_OK == response.getStatusCode()) {
                            setLoadResult(mainView, response.getText());
                        } else {
                            Window.alert("Something went wrong: HTTP Status Code: " + response.getStatusCode());
                        }
                    }
                });
            } catch (RequestException e) {
                throw new RuntimeException(e);
            }
        }
    }

    private void setLoadResult(MainView mainView, String uxf) {
        mainView.setDiagram(DiagramXmlParser.xmlToDiagram(uxf));
        // Any value of ?presentation will hide the sidebars (only if diagram get successfully loaded)
        String presentation = Window.Location.getParameter("presentation");
        if (presentation != null) {
            mainView.hideSideBars();
        }
    }

    // called by collab.js with a diagram received from another user
    private static void applyRemoteDiagram(MainView mainView, String uxf) {
        com.baselet.element.interfaces.Diagram diagram = DiagramXmlParser.xmlToDiagram(uxf);
        if (diagram != null) {
            mainView.setDiagram(diagram);
        }
    }

    private native void exportCollabApi(MainView mainView) /*-{
        $wnd.umletCollabApply = $entry(function(uxf) {
            @com.web.gwt.client.view.utils.WebStartupDiagramLoader::applyRemoteDiagram(Lcom/baselet/gwt/client/view/MainView;Ljava/lang/String;)(mainView, uxf);
        });
        if ($wnd.umletCollab && $wnd.umletCollab.onReady) {
            $wnd.umletCollab.onReady();
        }
    }-*/;
}
