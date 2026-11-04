package com.gourdai.core.portal.web;

import org.noear.snack4.Feature;
import org.noear.solon.annotation.Bean;
import org.noear.solon.annotation.Configuration;
import org.noear.solon.serialization.snack4.Snack4StringSerializer;

/**
 *
 * @author oisin
 *
 */
@Configuration
public class WebConfig {
    @Bean
    public void serializer(Snack4StringSerializer serializer) {
        serializer.getSerializeConfig().addFeatures(Feature.Write_DurationUsingSimple);
    }
}