package com.rdagent.app;

import android.webkit.CookieManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onStop() {
        super.onStop();
        CookieManager.getInstance().flush();
    }
}
