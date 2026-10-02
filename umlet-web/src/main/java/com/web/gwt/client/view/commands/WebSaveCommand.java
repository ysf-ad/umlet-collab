package com.web.gwt.client.view.commands;

import com.baselet.gwt.client.base.Notification;
import com.baselet.gwt.client.view.commands.SaveCommand;

/* Ctrl+S: diagrams are synced to the collaboration server continuously, there is nothing to save */
public class WebSaveCommand extends SaveCommand {

    @Override
    public void execute() {
        Notification.showInfo("Changes are saved automatically and shared with everyone in this diagram");
    }
}
