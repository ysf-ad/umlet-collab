package com.web.gwt.client.resources;

import com.baselet.gwt.client.resources.HelptextFactory;
import com.baselet.gwt.client.resources.HelptextResources;
import com.google.gwt.core.client.GWT;

public class WebHelptextFactory extends HelptextFactory {
    @Override
    public HelptextResources getInstance() {
        return GWT.create(WebHelptextResources.class);
    }
}
