package com.fimagina.cam;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CameraEnginePlugin.class);
        super.onCreate(savedInstanceState);
    }
}