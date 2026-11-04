package features.bot.gourdai;

import org.junit.jupiter.api.Test;

/**
 *
 * @author oisin
 *
 */
public class StringTest {
    @Test
    public void case1() {
        String str = " \n".trim();

        assert str.length() == 0;
    }
}
