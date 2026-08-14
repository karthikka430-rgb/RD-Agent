package com.rdagent.app;

import android.webkit.CookieManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onStop() {
        super.onStop();
        CookieManager.getInstance().flush();
    }
}
